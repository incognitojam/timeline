import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseCSV as parseCSVShared } from "../lib/csv";
import { getDb, initDb } from "../db/schema";
import { sanitizeAccountName } from "../lib/account";
import { formatDuration } from "../lib/format";

// ============================================================================
// Profile Parsing
// ============================================================================

interface FitbitProfile {
  id: string;
  display_name: string;
  full_name: string;
  email_address: string;
}

/**
 * Parse the Fitbit profile from Your Profile/Profile.csv.
 * Returns the profile data including display_name which can be used to derive account name.
 */
async function parseFitbitProfile(importPath: string): Promise<FitbitProfile> {
  const profilePath = join(importPath, "Your Profile", "Profile.csv");
  const file = Bun.file(profilePath);

  if (!(await file.exists())) {
    throw new Error(
      `Fitbit profile not found at ${profilePath}. ` +
      `The "Your Profile/Profile.csv" file is required to determine the account name. ` +
      `Ensure your Google Takeout export includes the Fitbit profile data.`
    );
  }

  const content = await file.text();
  const rows = parseCSV(content);

  if (rows.length === 0) {
    throw new Error(`Fitbit profile at ${profilePath} is empty or invalid.`);
  }

  const row = rows[0];
  const displayName = row.display_name;

  if (!displayName) {
    throw new Error(
      `Fitbit profile at ${profilePath} is missing display_name field. ` +
      `Available fields: ${Object.keys(row).join(", ")}`
    );
  }

  return {
    id: row.id || "",
    display_name: displayName,
    full_name: row.full_name || "",
    email_address: row.email_address || "",
  };
}

// ============================================================================
// Types
// ============================================================================

interface SleepStageSummary {
  count: number;
  minutes: number;
  thirtyDayAvgMinutes?: number;
}

interface SleepLevelData {
  dateTime: string;
  level: string;
  seconds: number;
}

interface SleepRecord {
  logId: number;
  dateOfSleep: string;
  startTime: string;
  endTime: string;
  duration: number;
  minutesToFallAsleep: number;
  minutesAsleep: number;
  minutesAwake: number;
  minutesAfterWakeup?: number;
  timeInBed: number;
  efficiency: number;
  type: string;
  infoCode?: number;
  logType: string;
  mainSleep: boolean;
  levels?: {
    summary?: {
      deep?: SleepStageSummary;
      wake?: SleepStageSummary;
      light?: SleepStageSummary;
      rem?: SleepStageSummary;
    };
    data?: SleepLevelData[];
    shortData?: SleepLevelData[];
  };
}

interface SleepScoreRow {
  sleep_log_entry_id: string;
  timestamp: string;
  overall_score: string;
  composition_score: string;
  revitalization_score: string;
  duration_score: string;
  deep_sleep_in_minutes: string;
  resting_heart_rate: string;
  restlessness: string;
}

// New format types (Jan 2026)
interface UserSleepScoreRow {
  sleep_id: string;
  sleep_score_id: string;
  score_time: string;
  overall_score: string;
  duration_score: string;
  composition_score: string;
  revitalization_score: string;
  sleep_time_minutes: string;
  deep_sleep_minutes: string;
  rem_sleep_percent: string;
  resting_heart_rate: string;
  sleep_goal_minutes: string;
  waso_count_long_wakes: string;
  waso_count_all_wake_time: string;
  restlessness_normalized: string;
}

interface DailyHRVSummaryRow {
  timestamp: string;
  rmssd: string;
  nremhr: string;
  entropy: string;
}

interface DailySpO2Row {
  timestamp: string;
  average_value: string;
  lower_bound: string;
  upper_bound: string;
}

interface RespiratoryRateRow {
  timestamp: string;
  "deep sleep stats - milli breaths per minute"?: string;
  "light sleep stats - milli breaths per minute"?: string;
  "rem sleep stats - milli breaths per minute"?: string;
  "full sleep stats - milli breaths per minute"?: string;
  data_source?: string;
  [key: string]: string | undefined;
}

// ============================================================================
// CSV Parsing
// ============================================================================

// Fitbit Takeout CSVs pad cells with whitespace; trim values on parse.
function parseCSV(content: string): Record<string, string>[] {
  return parseCSVShared(content, { trimValues: true });
}

// ============================================================================
// Helpers
// ============================================================================


function formatMinutes(mins: number, avgMins?: number): string {
  if (avgMins !== undefined) {
    return `${mins}m (avg ${avgMins}m)`;
  }
  return `${mins}m`;
}

function parseFitbitTimestamp(ts: string): string {
  // Format: "2023-11-09T04:14:00.000" - already ISO-ish, just ensure it ends with Z
  if (ts.endsWith("Z")) return ts;
  // Remove milliseconds if present and add Z
  const cleaned = ts.replace(/\.\d{3}$/, "");
  return cleaned + "Z";
}

// ============================================================================
// Sleep Parser
// ============================================================================

async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (pattern.test(entry)) {
        files.push(join(dir, entry));
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files;
}

// ============================================================================
// Format Detection (Old vs New Fitbit Takeout Format)
// ============================================================================

type FitbitFormat = "old" | "new" | "unknown";

async function detectFitbitFormat(importPath: string): Promise<FitbitFormat> {
  // New format indicator: Health Fitness Data_GoogleData/UserSleepScores_*.csv
  const newFormatDir = join(importPath, "Health Fitness Data_GoogleData");
  const newFormatFiles = await findFiles(newFormatDir, /^UserSleepScores_.*\.csv$/);
  if (newFormatFiles.length > 0) {
    return "new";
  }

  // Old format indicator: Global Export Data/sleep-*.json
  const oldFormatDir = join(importPath, "Global Export Data");
  const oldFormatFiles = await findFiles(oldFormatDir, /^sleep-\d{4}-\d{2}-\d{2}\.json$/);
  if (oldFormatFiles.length > 0) {
    return "old";
  }

  return "unknown";
}

// ============================================================================
// New Format Parsers (Jan 2026)
// ============================================================================

async function parseUserSleepScores(
  db: Database,
  importPath: string,
  sourceAccount: string,
  importBatch: string,
  insert: ReturnType<Database["prepare"]>
): Promise<number> {
  const dir = join(importPath, "Health Fitness Data_GoogleData");
  const files = await findFiles(dir, /^UserSleepScores_.*\.csv$/);

  if (files.length === 0) return 0;

  console.log(`  Found ${files.length} UserSleepScores CSV files (new format)`);
  let count = 0;

  for (const filePath of files) {
    try {
      const rows = parseCSV(await Bun.file(filePath).text());
      console.log(`  Processing ${basename(filePath)}: ${rows.length} records`);

      for (const row of rows) {
        const r = row as unknown as UserSleepScoreRow;
        if (!r.sleep_id || !r.score_time) continue;

        // Parse score_time: "2025-11-27 12:17:30+0000"
        const timestamp = r.score_time.replace(" ", "T").replace(/\+(\d{4})$/, "+$1").replace(/\+(\d{2})(\d{2})$/, "+$1:$2");
        const sourceId = `sleep-new:${r.sleep_id}`;

        // Format duration
        const sleepMins = parseInt(r.sleep_time_minutes) || 0;
        const sleepHours = Math.floor(sleepMins / 60);
        const sleepRemMins = sleepMins % 60;
        const durationStr = sleepRemMins > 0 ? `${sleepHours}h ${sleepRemMins}m` : `${sleepHours}h`;

        // Format scores (they're floats, round for display)
        const overall = Math.round(parseFloat(r.overall_score) || 0);
        const duration = Math.round(parseFloat(r.duration_score) || 0);
        const composition = Math.round(parseFloat(r.composition_score) || 0);
        const revitalization = Math.round(parseFloat(r.revitalization_score) || 0);

        const title = `Sleep: ${durationStr} (score: ${overall}/100)`;

        // Build content
        const contentParts: string[] = [];
        contentParts.push(`Sleep score: ${overall}/100 (duration: ${duration}, composition: ${composition}, revitalization: ${revitalization})`);

        const deepMins = parseInt(r.deep_sleep_minutes) || 0;
        const remPct = parseFloat(r.rem_sleep_percent) || 0;
        contentParts.push(`${durationStr} total, ${deepMins}m deep, ${remPct.toFixed(0)}% REM`);

        if (r.resting_heart_rate) {
          contentParts.push(`Resting HR: ${r.resting_heart_rate} bpm`);
        }

        const content = contentParts.join("\n");
        const tags = ["fitbit", "new-format", "sleep"];

        try {
          insert.run(
            "fitbit",
            sourceId,
            sourceAccount,
            "sleep",
            timestamp,
            null, // no end_timestamp in new format
            sleepMins * 60 * 1000, // duration in ms
            title,
            content,
            JSON.stringify(tags),
            JSON.stringify(row),
            importBatch
          );
          count++;
        } catch {
          // Duplicate
        }
      }
    } catch (e) {
      console.error(`  Error parsing ${basename(filePath)}:`, e);
    }
  }

  return count;
}

async function parseDailyHRVSummary(
  db: Database,
  importPath: string,
  sourceAccount: string,
  importBatch: string,
  insert: ReturnType<Database["prepare"]>
): Promise<number> {
  const dir = join(importPath, "Heart Rate Variability");
  // New format: "Daily Heart Rate Variability Summary - 2023-10-.csv" or "...2023-10-(2).csv"
  const files = await findFiles(dir, /^Daily Heart Rate Variability Summary - .*\.csv$/);

  if (files.length === 0) return 0;

  console.log(`  Found ${files.length} Daily HRV Summary CSV files (new format)`);
  let count = 0;
  const seenDates = new Set<string>();

  for (const filePath of files) {
    try {
      const rows = parseCSV(await Bun.file(filePath).text());

      for (const row of rows) {
        const r = row as unknown as DailyHRVSummaryRow;
        if (!r.timestamp) continue;

        const date = r.timestamp.split("T")[0];
        if (seenDates.has(date)) continue;
        seenDates.add(date);

        const sourceId = `hrv:${date}`;
        const rmssd = parseFloat(r.rmssd) || 0;
        const nremhr = parseFloat(r.nremhr) || 0;
        const entropy = parseFloat(r.entropy) || 0;

        const title = `HRV: ${rmssd.toFixed(1)}ms RMSSD`;
        const content = `RMSSD: ${rmssd.toFixed(1)} ms, NREM HR: ${nremhr.toFixed(0)} bpm, Entropy: ${entropy.toFixed(2)}`;
        const tags = ["fitbit", "new-format", "hrv"];

        try {
          insert.run(
            "fitbit",
            sourceId,
            sourceAccount,
            "daily:hrv",
            `${date}T00:00:00Z`,
            null,
            null,
            title,
            content,
            JSON.stringify(tags),
            JSON.stringify(row),
            importBatch
          );
          count++;
        } catch {
          // Duplicate
        }
      }
    } catch (e) {
      console.error(`  Error parsing ${basename(filePath)}:`, e);
    }
  }

  return count;
}

async function parseDailySpO2(
  db: Database,
  importPath: string,
  sourceAccount: string,
  importBatch: string,
  insert: ReturnType<Database["prepare"]>
): Promise<number> {
  const dir = join(importPath, "Oxygen Saturation (SpO2)");
  // Pattern: "Daily SpO2 - 2025-12-19-2026-01-08.csv"
  const files = await findFiles(dir, /^Daily SpO2 - .*\.csv$/);

  if (files.length === 0) return 0;

  console.log(`  Found ${files.length} Daily SpO2 CSV files`);
  let count = 0;
  const seenDates = new Set<string>();

  for (const filePath of files) {
    try {
      const rows = parseCSV(await Bun.file(filePath).text());

      for (const row of rows) {
        const r = row as unknown as DailySpO2Row;
        if (!r.timestamp) continue;

        // Timestamp: "2025-12-19T00:00:00Z"
        const date = r.timestamp.split("T")[0];
        if (seenDates.has(date)) continue;
        seenDates.add(date);

        const sourceId = `spo2:${date}`;
        const avg = parseFloat(r.average_value) || 0;
        const lower = parseFloat(r.lower_bound) || 0;
        const upper = parseFloat(r.upper_bound) || 0;

        const title = `SpO2: ${avg.toFixed(1)}%`;
        const content = `Average: ${avg.toFixed(1)}% (range: ${lower.toFixed(1)}% - ${upper.toFixed(1)}%)`;
        const tags = ["fitbit", "new-format", "spo2"];

        try {
          insert.run(
            "fitbit",
            sourceId,
            sourceAccount,
            "daily:spo2",
            `${date}T00:00:00Z`,
            null,
            null,
            title,
            content,
            JSON.stringify(tags),
            JSON.stringify(row),
            importBatch
          );
          count++;
        } catch {
          // Duplicate
        }
      }
    } catch (e) {
      console.error(`  Error parsing ${basename(filePath)}:`, e);
    }
  }

  return count;
}

async function parseRespiratoryRate(
  db: Database,
  importPath: string,
  sourceAccount: string,
  importBatch: string,
  insert: ReturnType<Database["prepare"]>
): Promise<number> {
  const dir = join(importPath, "Physical Activity_GoogleData");
  // Pattern: "respiratory_rate_sleep_summary_2025-12-01.csv"
  const files = await findFiles(dir, /^respiratory_rate_sleep_summary_.*\.csv$/);

  if (files.length === 0) return 0;

  console.log(`  Found ${files.length} Respiratory Rate CSV files`);
  let count = 0;
  const seenDates = new Set<string>();

  for (const filePath of files) {
    try {
      const rows = parseCSV(await Bun.file(filePath).text());

      for (const row of rows) {
        const r = row as RespiratoryRateRow;
        if (!r.timestamp) continue;

        // Timestamp: "2025-12-03T09:31:30Z"
        const date = r.timestamp.split("T")[0];
        if (seenDates.has(date)) continue;
        seenDates.add(date);

        const sourceId = `breathing:${date}`;

        // Get full sleep breathing rate (column says "milli" but values are in breaths/min)
        const fullSleepRate = parseFloat(r["full sleep stats - milli breaths per minute"] || "0");

        const title = `Breathing: ${fullSleepRate.toFixed(1)} breaths/min`;
        const content = `Breathing rate: ${fullSleepRate.toFixed(1)} breaths/min`;
        const tags = ["fitbit", "new-format", "breathing"];

        try {
          insert.run(
            "fitbit",
            sourceId,
            sourceAccount,
            "daily:breathing",
            `${date}T00:00:00Z`,
            null,
            null,
            title,
            content,
            JSON.stringify(tags),
            JSON.stringify(row),
            importBatch
          );
          count++;
        } catch {
          // Duplicate
        }
      }
    } catch (e) {
      console.error(`  Error parsing ${basename(filePath)}:`, e);
    }
  }

  return count;
}

export async function importFitbitData(
  db: Database,
  importPath: string,
  sourceAccount?: string
): Promise<number> {
  // If no account provided, derive from profile
  let accountName = sourceAccount;
  if (!accountName) {
    const profile = await parseFitbitProfile(importPath);
    accountName = sanitizeAccountName(profile.display_name);
    if (!accountName) {
      throw new Error(
        `Could not derive account name from Fitbit display_name: "${profile.display_name}"`
      );
    }
    console.log(`  Account derived from profile: ${accountName}`);
  }

  const importBatch = `fitbit-${accountName}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalEvents = 0;
  const stats: Record<string, number> = {};

  // -------------------------------------------------------------------------
  // Detect Format (Old vs New)
  // -------------------------------------------------------------------------
  const format = await detectFitbitFormat(importPath);
  console.log(`  Detected format: ${format}`);

  // -------------------------------------------------------------------------
  // New Format Parsing (Jan 2026)
  // -------------------------------------------------------------------------
  if (format === "new") {
    // Parse UserSleepScores (new sleep format)
    const sleepCount = await parseUserSleepScores(db, importPath, accountName, importBatch, insert);
    stats["sleep"] = sleepCount;
    totalEvents += sleepCount;

    // Parse Daily HRV Summary (new format)
    const hrvCount = await parseDailyHRVSummary(db, importPath, accountName, importBatch, insert);
    stats["daily:hrv"] = hrvCount;
    totalEvents += hrvCount;

    // Parse Daily SpO2 (new data type)
    const spo2Count = await parseDailySpO2(db, importPath, accountName, importBatch, insert);
    stats["daily:spo2"] = spo2Count;
    totalEvents += spo2Count;

    // Parse Respiratory Rate (new data type)
    const breathingCount = await parseRespiratoryRate(db, importPath, accountName, importBatch, insert);
    stats["daily:breathing"] = breathingCount;
    totalEvents += breathingCount;

    // Daily readiness uses same format - parse it below
  }

  // -------------------------------------------------------------------------
  // Old Format: Load Sleep Scores into a map
  // -------------------------------------------------------------------------
  if (format === "old" || format === "unknown") {
    const sleepScores = new Map<string, SleepScoreRow>();
    const scoreFile = Bun.file(join(importPath, "Sleep Score", "sleep_score.csv"));
    if (await scoreFile.exists()) {
      const rows = parseCSV(await scoreFile.text());
      for (const row of rows) {
        sleepScores.set(row.sleep_log_entry_id, row as unknown as SleepScoreRow);
      }
      console.log(`  Loaded ${sleepScores.size} sleep scores`);
    }

    // -------------------------------------------------------------------------
    // Old Format: Parse Sleep Records
    // -------------------------------------------------------------------------
    const sleepDir = join(importPath, "Global Export Data");
    const sleepFiles = await findFiles(sleepDir, /^sleep-\d{4}-\d{2}-\d{2}\.json$/);

    if (sleepFiles.length > 0) {
    console.log(`  Found ${sleepFiles.length} sleep JSON files`);

    const insertSleep = db.transaction((records: SleepRecord[]) => {
      for (const record of records) {
        const sourceId = `sleep:${record.logId}`;
        const eventType = record.mainSleep ? "sleep" : "sleep:nap";
        const durationStr = formatDuration(record.duration);

        // Build title
        let title: string;
        if (record.mainSleep) {
          title = `Sleep: ${durationStr} (${record.efficiency}% efficiency)`;
        } else {
          title = `Nap: ${durationStr}`;
        }

        // Build content with stage summary
        const contentParts: string[] = [];
        if (record.levels?.summary) {
          const s = record.levels.summary;
          const stageParts: string[] = [];
          if (s.deep) stageParts.push(`Deep: ${formatMinutes(s.deep.minutes, s.deep.thirtyDayAvgMinutes)}`);
          if (s.light) stageParts.push(`Light: ${formatMinutes(s.light.minutes, s.light.thirtyDayAvgMinutes)}`);
          if (s.rem) stageParts.push(`REM: ${formatMinutes(s.rem.minutes, s.rem.thirtyDayAvgMinutes)}`);
          if (s.wake) stageParts.push(`Wake: ${s.wake.minutes}m`);
          contentParts.push(stageParts.join(" | "));
        }

        // Add sleep score if available
        const score = sleepScores.get(String(record.logId));
        if (score) {
          const scoreLine = `Sleep score: ${score.overall_score}/100 (RHR: ${score.resting_heart_rate} bpm)`;
          contentParts.push(scoreLine);
        }

        const content = contentParts.join("\n");

        // Build tags
        const tags: string[] = [];
        if (record.levels?.summary) {
          if (record.levels.summary.deep) tags.push("deep");
          if (record.levels.summary.light) tags.push("light");
          if (record.levels.summary.rem) tags.push("rem");
          if (record.levels.summary.wake) tags.push("wake");
        }
        if (record.logType) tags.push(record.logType);
        tags.push(record.mainSleep ? "main-sleep" : "nap");

        // Parse timestamps - Fitbit uses local time without timezone
        const startTime = parseFitbitTimestamp(record.startTime);
        const endTime = parseFitbitTimestamp(record.endTime);

        try {
          insert.run(
            "fitbit",
            sourceId,
            accountName,
            eventType,
            startTime,
            endTime,
            record.duration,
            title,
            content || null,
            JSON.stringify(tags),
            JSON.stringify(record),
            importBatch
          );
          stats[eventType] = (stats[eventType] || 0) + 1;
          totalEvents++;
        } catch {
          // Duplicate, skip
        }
      }
    });

    for (const filePath of sleepFiles) {
      try {
        const data: SleepRecord[] = await Bun.file(filePath).json();
        console.log(`  Processing ${basename(filePath)}: ${data.length} records`);
        insertSleep(data);
      } catch (e) {
        console.error(`  Error parsing ${basename(filePath)}:`, e);
      }
    }
    }

    // -------------------------------------------------------------------------
    // Old Format: Parse Stress Score
    // -------------------------------------------------------------------------
    const stressFile = Bun.file(join(importPath, "Stress Score", "Stress Score.csv"));
    if (await stressFile.exists()) {
      console.log(`  Processing stress scores`);
      try {
        const rows = parseCSV(await stressFile.text());
        for (const row of rows) {
          const date = row.DATE || row.date;
          const score = row.STRESS_SCORE || row.stress_score;

          if (!date || !score) continue;

          // Skip if calculation failed
          if (row.CALCULATION_FAILED === "true" || row.calculation_failed === "true") continue;

          const sourceId = `stress:${date}`;
          const timestamp = `${date}T00:00:00Z`;

          try {
            insert.run(
              "fitbit",
              sourceId,
              accountName,
              "daily:stress",
              timestamp,
              null,
              null,
              `Stress Score: ${score}/100`,
              null,
              JSON.stringify(["stress"]),
              JSON.stringify(row),
              importBatch
            );
            stats["daily:stress"] = (stats["daily:stress"] || 0) + 1;
            totalEvents++;
          } catch {
            // Duplicate
          }
        }
      } catch (e) {
        console.error(`  Error parsing stress scores:`, e);
      }
    }

    // -------------------------------------------------------------------------
    // Old Format: Parse HRV Data (Histogram format)
    // -------------------------------------------------------------------------
    const hrvDir = join(importPath, "Heart Rate Variability");
    const hrvFiles = await findFiles(hrvDir, /^Heart Rate Variability Histogram - \d{4}-\d{2}-\d{2}\.csv$/);

    if (hrvFiles.length > 0) {
      console.log(`  Found ${hrvFiles.length} HRV Histogram CSV files (old format)`);

      for (const filePath of hrvFiles) {
        try {
          const rows = parseCSV(await Bun.file(filePath).text());
          // HRV files have daily entries
          const seenDates = new Set<string>();

          for (const row of rows) {
            // Timestamp format: "2024-01-15T08:30:00Z" or similar
            const timestamp = row.timestamp || row.TIMESTAMP;
            if (!timestamp) continue;

            const date = timestamp.split("T")[0];
            if (seenDates.has(date)) continue;
            seenDates.add(date);

            const rmssd = row.rmssd || row.RMSSD;
            const sourceId = `hrv:${date}`;

            try {
              insert.run(
                "fitbit",
                sourceId,
                accountName,
                "daily:hrv",
                `${date}T00:00:00Z`,
                null,
                null,
                rmssd ? `HRV: ${Math.round(parseFloat(rmssd))}ms RMSSD` : `HRV data for ${date}`,
                null,
                JSON.stringify(["hrv"]),
                JSON.stringify(row),
                importBatch
              );
              stats["daily:hrv"] = (stats["daily:hrv"] || 0) + 1;
              totalEvents++;
            } catch {
              // Duplicate
            }
          }
        } catch (e) {
          console.error(`  Error parsing ${basename(filePath)}:`, e);
        }
      }
    }
  } // End of old format block

  // -------------------------------------------------------------------------
  // Parse Daily Readiness (works for both formats)
  // -------------------------------------------------------------------------
  const readinessDir = join(importPath, "Daily Readiness");
  const readinessFiles = await findFiles(readinessDir, /^Daily Readiness Score - \d{4}-\d{2}-\d{2}\.csv$/);

  if (readinessFiles.length > 0) {
    console.log(`  Found ${readinessFiles.length} readiness CSV files`);

    for (const filePath of readinessFiles) {
      try {
        const rows = parseCSV(await Bun.file(filePath).text());
        for (const row of rows) {
          // Column names vary: date, timestamp, readiness_score, readiness_score_value, etc.
          const date = row.date || row.DATE || row.timestamp?.split("T")[0];
          const score = row.readiness_score || row.readiness_score_value || row.score || row.READINESS_SCORE;

          if (!date || !score) continue;

          const sourceId = `readiness:${date}`;
          const timestamp = `${date}T00:00:00Z`;

          try {
            insert.run(
              "fitbit",
              sourceId,
              accountName,
              "daily:readiness",
              timestamp,
              null, // no end_timestamp
              null, // no duration
              `Readiness: ${score}/100`,
              null,
              JSON.stringify(["fitbit", "readiness"]),
              JSON.stringify(row),
              importBatch
            );
            stats["daily:readiness"] = (stats["daily:readiness"] || 0) + 1;
            totalEvents++;
          } catch {
            // Duplicate
          }
        }
      } catch (e) {
        console.error(`  Error parsing ${basename(filePath)}:`, e);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log(`\n  Import complete:`);
  for (const [type, count] of Object.entries(stats).sort()) {
    console.log(`    ${type}: ${count}`);
  }
  console.log(`    Total: ${totalEvents}`);
  console.log(`    Batch ID: ${importBatch}`);

  return totalEvents;
}

// ============================================================================
// CLI
// ============================================================================

// Only run CLI when this file is executed directly, not when imported
if (import.meta.main) {
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/fitbit.ts <import-path>");
  console.log("");
  console.log("Import path should contain Fitbit folder structure from Google Takeout.");
  console.log("");
  console.log("Account name is automatically derived from Your Profile/Profile.csv");
  console.log("using the display_name field.");
  console.log("");
  console.log("Old format (Aug 2024):");
  console.log("  - Global Export Data/sleep-*.json");
  console.log("  - Sleep Score/sleep_score.csv");
  console.log("  - Daily Readiness/");
  console.log("  - Stress Score/Stress Score.csv");
  console.log("  - Heart Rate Variability/");
  console.log("");
  console.log("New format (Jan 2026):");
  console.log("  - Health Fitness Data_GoogleData/UserSleepScores_*.csv");
  console.log("  - Heart Rate Variability/Daily Heart Rate Variability Summary - *.csv");
  console.log("  - Oxygen Saturation (SpO2)/Daily SpO2 - *.csv");
  console.log("  - Physical Activity_GoogleData/respiratory_rate_sleep_summary_*.csv");
  console.log("  - Daily Readiness/");
  console.log("");
  console.log("Format is auto-detected based on files present.");
  console.log("");
  console.log("Example: bun run src/parsers/fitbit.ts ./imports/fitbit");
  process.exit(1);
}

const importPath = args[0];

console.log(`Importing Fitbit data from ${importPath}\n`);

// Parse profile to get account name
const profile = await parseFitbitProfile(importPath);
const accountName = sanitizeAccountName(profile.display_name);

if (!accountName) {
  throw new Error(
    `Could not derive account name from Fitbit display_name: "${profile.display_name}"`
  );
}

console.log(`Profile: ${profile.full_name} (${profile.display_name})`);
console.log(`Account: ${accountName}\n`);

const db = getDb();
initDb(db);

await importFitbitData(db, importPath, accountName);

db.close();
}
