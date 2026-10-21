import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { getDb, initDb } from "../db/schema";
import { formatDuration } from "../lib/format";

interface FitValue {
  intVal?: number;
  fpVal?: number;
  stringVal?: string;
  value?: { intVal?: number; fpVal?: number; stringVal?: string };
}

interface FitDataPoint {
  startTimeNanos: string;
  endTimeNanos: string;
  value?: FitValue[];
  fitValue?: FitValue[];
}

interface FitDataSource {
  dataType?: {
    name: string;
  };
}

interface FitFile {
  "Data Source"?: FitDataSource;
  "Data Points"?: FitDataPoint[];
  dataSource?: FitDataSource;
  dataPoints?: FitDataPoint[];
}

// Activity type mapping from Google Fit
const ACTIVITY_TYPES: Record<number, string> = {
  0: "unknown", 1: "biking", 2: "on-foot", 3: "still", 5: "in-vehicle",
  7: "walking", 8: "running", 9: "aerobics", 16: "road-biking",
  26: "dancing", 42: "hiking", 53: "meditation", 57: "pilates",
  64: "jogging", 81: "sleeping", 89: "strength-training", 109: "weightlifting",
  112: "yoga", 113: "zumba", 115: "light-sleep", 116: "deep-sleep", 117: "rem-sleep",
};

const SKIP_ACTIVITIES = new Set(["unknown", "still", "elevator", "escalator", "awake"]);
const MIN_DURATION_MS = 60000;

function nanosToIso(nanos: string): string {
  const ms = parseInt(nanos) / 1_000_000;
  return new Date(ms).toISOString();
}

function nanosToDurationMs(startNanos: string, endNanos: string): number {
  return (parseInt(endNanos) - parseInt(startNanos)) / 1_000_000;
}


function getActivityType(activityCode: number): string {
  return ACTIVITY_TYPES[activityCode] || `activity-${activityCode}`;
}

async function importGoogleFit(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `google-fit-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stats: Record<string, number> = {};
  let skipped = 0;
  let errors = 0;
  const allFiles: string[] = [];

  async function scanDirectory(dir: string) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (entry.endsWith(".json") && entry.includes("derived_com.google")) {
        allFiles.push(fullPath);
      } else {
        try {
          await readdir(fullPath);
          await scanDirectory(fullPath);
        } catch {
          // Not a directory
        }
      }
    }
  }

  console.log(`Scanning ${importPath} for Google Fit JSON files...`);
  await scanDirectory(importPath);
  console.log(`Found ${allFiles.length} Fit JSON files`);

  if (allFiles.length === 0) {
    console.log("\nNo Google Fit JSON files found.");
    console.log("Expected files like: derived_com.google.activity.segment_*.json");
    return;
  }

  for (const filePath of allFiles) {
    const fileName = basename(filePath);

    // Only process activity segment files
    if (!fileName.includes("activity.segment")) continue;

    let data: FitFile;
    try {
      data = await Bun.file(filePath).json();
    } catch (e) {
      console.error(`Failed to parse ${fileName}:`, e);
      errors++;
      continue;
    }

    const dataPoints = data["Data Points"] || data.dataPoints || [];
    if (dataPoints.length === 0) continue;

    console.log(`Processing ${fileName}: ${dataPoints.length} data points`);

    const insertMany = db.transaction((points: FitDataPoint[]) => {
      for (const point of points) {
        try {
          if (!point.startTimeNanos || !point.endTimeNanos) {
            skipped++;
            continue;
          }

          const values = point.value || point.fitValue || [];
          // Handle both formats: direct intVal or nested value.intVal
          const activityValue = values.find((v) => v.intVal !== undefined || v.value?.intVal !== undefined);
          const activityCode = activityValue?.intVal ?? activityValue?.value?.intVal ?? 0;
          const activityName = getActivityType(activityCode);

          if (SKIP_ACTIVITIES.has(activityName)) {
            skipped++;
            continue;
          }

          const durationMs = nanosToDurationMs(point.startTimeNanos, point.endTimeNanos);
          if (durationMs < MIN_DURATION_MS) {
            skipped++;
            continue;
          }

          const startTime = nanosToIso(point.startTimeNanos);
          const endTime = nanosToIso(point.endTimeNanos);
          const eventType = `activity:${activityName}`;
          const durationStr = formatDuration(durationMs);
          const title = `${activityName.replace(/-/g, " ")} (${durationStr})`;
          const sourceId = `${activityName}-${point.startTimeNanos}`;

          insert.run(
            "google-fit",
            sourceId,
            sourceAccount,
            eventType,
            startTime,
            endTime,
            durationMs,
            title,
            `${activityName} activity for ${durationStr}`,
            JSON.stringify([activityName]),
            JSON.stringify(point),
            importBatch
          );

          stats[eventType] = (stats[eventType] || 0) + 1;
        } catch {
          errors++;
        }
      }
    });

    insertMany(dataPoints);
  }

  console.log(`\nImport complete:`);
  console.log(`  Activity types found:`);
  const sortedStats = Object.entries(stats).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedStats) {
    console.log(`    ${type}: ${count}`);
  }
  console.log(`  Total events: ${Object.values(stats).reduce((a, b) => a + b, 0)}`);
  console.log(`  Skipped: ${skipped} (short/still/unknown)`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Batch ID: ${importBatch}`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/google-fit.ts <import-path> [account-name]");
  console.log("Example: bun run src/parsers/google-fit.ts /tmp/fit-import my-account");
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

console.log(`Importing Google Fit data from ${importPath}`);
console.log(`Account: ${accountName}\n`);

const db = getDb();
initDb(db);

await importGoogleFit(db, importPath, accountName);

db.close();
