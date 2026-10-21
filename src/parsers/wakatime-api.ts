/**
 * WakaTime/Wakapi API Parser
 *
 * Syncs coding activity from WakaTime or compatible servers (like Wakapi).
 * Reads config from ~/.wakatime.cfg for API URL and key.
 *
 * Uses heartbeats endpoint and aggregates into sessions using the same
 * logic as the file-based wakatime.ts parser.
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import {
  aggregateIntoSessions,
  buildSessionMetadata,
  generateSessionContent,
  generateSessionTitle,
  type Session,
} from "../lib/wakatime";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Config
const CONFIG_PATH = join(homedir(), ".wakatime.cfg");

interface WakaTimeConfig {
  api_url: string;
  api_key: string;
}

// Heartbeat structure from API
interface WakaTimeHeartbeat {
  id: string;
  entity: string;
  type: string;
  category: string;
  time: number; // Unix timestamp
  project: string | null;
  project_root_count: number | null;
  branch: string | null;
  language: string | null;
  dependencies: string[] | null;
  lines: number | null;
  lineno: number | null;
  cursorpos: number | null;
  is_write: boolean;
  user_agent_id: string;
  machine_name_id: string;
  created_at: string;
}

function loadConfig(): WakaTimeConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;

  const content = readFileSync(CONFIG_PATH, "utf-8");
  const config: Partial<WakaTimeConfig> = {};

  for (const line of content.split("\n")) {
    const match = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      if (key === "api_url") config.api_url = value.trim();
      if (key === "api_key") config.api_key = value.trim();
    }
  }

  if (!config.api_url || !config.api_key) return null;
  return config as WakaTimeConfig;
}

// API helpers
async function wakaGet<T>(config: WakaTimeConfig, endpoint: string): Promise<T> {
  // Wakapi uses /compat/wakatime/v1 for WakaTime-compatible API
  const baseUrl = config.api_url.replace(/\/api\/?$/, "");
  const url = `${baseUrl}/api/compat/wakatime/v1${endpoint}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${btoa(config.api_key)}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Wakapi API error ${response.status}: ${error}`);
  }

  return response.json();
}

// Fetch heartbeats for a specific date
async function fetchHeartbeats(
  config: WakaTimeConfig,
  date: string // YYYY-MM-DD
): Promise<WakaTimeHeartbeat[]> {
  interface HeartbeatsResponse {
    data: WakaTimeHeartbeat[];
  }

  const response = await wakaGet<HeartbeatsResponse>(
    config,
    `/users/current/heartbeats?date=${date}`
  );

  return response.data || [];
}

// Get latest date from DB for incremental sync
function getLatestDate(db: Database): string | null {
  const result = db.query<{ latest: string | null }, []>(`
    SELECT MAX(DATE(timestamp)) as latest FROM events WHERE source = 'wakatime'
  `).get();
  return result?.latest || null;
}

// Generate array of dates between start and end
function getDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  const endDate = new Date(end);

  while (current <= endDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

export interface WakaTimeSyncStats {
  sessions: number;
  heartbeats: number;
  skipped: number;
  daysProcessed: number;
}

export async function syncWakaTime(
  sourceAccount: string = "default",
  daysBack: number = 14, // Default to last 2 weeks for incremental
  forceFullSync: boolean = false // Ignore existing data and go back daysBack
): Promise<WakaTimeSyncStats> {
  const config = loadConfig();
  if (!config) {
    throw new Error("WakaTime not configured. Check ~/.wakatime.cfg");
  }

  console.log(`Using Wakapi server: ${config.api_url}`);

  const db = getDb();
  initDb(db);

  // Determine date range
  const today = new Date().toISOString().split("T")[0];
  let startDate: string;

  const latestDate = getLatestDate(db);
  if (latestDate && !forceFullSync) {
    // Incremental: start from the SAME day as latest (overlap to catch mid-day syncs)
    // but use daysBack if that's further back
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - daysBack);
    const daysAgoStr = daysAgo.toISOString().split("T")[0];

    startDate = latestDate < daysAgoStr ? daysAgoStr : latestDate;

    console.log(`Incremental sync from ${startDate} (latest in DB: ${latestDate})`);
  } else {
    // Full sync - go back daysBack days (ignoring existing data)
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - daysBack);
    startDate = daysAgo.toISOString().split("T")[0];
    console.log(`Full sync from ${startDate} (${daysBack} days back)`);
  }

  const dates = getDateRange(startDate, today);
  console.log(`Fetching ${dates.length} day(s)...`);

  const stats: WakaTimeSyncStats = {
    sessions: 0,
    heartbeats: 0,
    skipped: 0,
    daysProcessed: 0,
  };

  const importBatch = `wakatime-api-${sourceAccount}-${Date.now()}`;

  // Use upsert to update sessions if they've been extended with more heartbeats
  const upsert = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id, source_account) DO UPDATE SET
      end_timestamp = excluded.end_timestamp,
      duration_ms = excluded.duration_ms,
      title = excluded.title,
      content = excluded.content,
      tags = excluded.tags,
      raw_data = excluded.raw_data,
      import_batch = excluded.import_batch
    WHERE excluded.end_timestamp > events.end_timestamp
       OR excluded.duration_ms > events.duration_ms
  `);

  // Process each day
  for (const date of dates) {
    try {
      const heartbeats = await fetchHeartbeats(config, date);
      stats.heartbeats += heartbeats.length;

      if (heartbeats.length === 0) {
        stats.daysProcessed++;
        continue;
      }

      const sessions = aggregateIntoSessions(heartbeats);

      const insertSessions = db.transaction((sessionsToInsert: Session[]) => {
        for (const session of sessionsToInsert) {
          const timestamp = new Date(session.startTime * 1000).toISOString();
          const endTimestamp = new Date(session.endTime * 1000).toISOString();
          const title = generateSessionTitle(session);
          const content = generateSessionContent(session);

          const tags: string[] = [];
          for (const lang of session.languages.keys()) tags.push(`language:${lang}`);
          for (const project of session.projects.keys()) tags.push(`project:${project}`);
          for (const branch of session.branches) tags.push(`branch:${branch}`);
          for (const cat of session.categories) {
            if (cat !== "coding") tags.push(`category:${cat}`);
          }
          for (const machine of session.machines) tags.push(`machine:${machine}`);

          try {
            const result = upsert.run(
              "wakatime",
              `session:${session.id}`,
              sourceAccount,
              "code:session",
              timestamp,
              endTimestamp,
              session.durationMs,
              title,
              content,
              JSON.stringify(tags),
              JSON.stringify(buildSessionMetadata(session)),
              importBatch
            );
            // result.changes is 1 for insert or update, 0 if WHERE clause not met
            if (result.changes > 0) {
              stats.sessions++;
            } else {
              stats.skipped++;
            }
          } catch {
            stats.skipped++;
          }
        }
      });

      insertSessions(sessions);
      stats.daysProcessed++;

      // Progress
      if (dates.length > 7) {
        process.stdout.write(`\r  ${date}: ${heartbeats.length} heartbeats → ${sessions.length} sessions`);
      }

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 100));
    } catch (e) {
      console.error(`\nError fetching ${date}:`, e);
    }
  }

  if (dates.length > 7) console.log(); // Newline after progress

  console.log(`\nSync complete:`);
  console.log(`  Days processed: ${stats.daysProcessed}`);
  console.log(`  Heartbeats fetched: ${stats.heartbeats}`);
  console.log(`  Sessions created: ${stats.sessions}`);
  console.log(`  Skipped (duplicates): ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  db.close();
  return stats;
}

function showStatus(): void {
  const config = loadConfig();

  console.log("WakaTime/Wakapi Status");
  console.log("=".repeat(40));

  if (!config) {
    console.log("Not configured. Create ~/.wakatime.cfg with:");
    console.log("  [settings]");
    console.log("  api_url = https://your-wakapi-server/api");
    console.log("  api_key = your-api-key");
    return;
  }

  console.log(`API URL: ${config.api_url}`);
  console.log(`API Key: ${config.api_key.substring(0, 8)}...`);
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "status") {
    showStatus();
  } else if (command === "test") {
    const config = loadConfig();
    if (!config) {
      console.error("Not configured. Create ~/.wakatime.cfg with:");
      console.error("  [settings]");
      console.error("  api_url = https://your-wakapi-server/api");
      console.error("  api_key = your-api-key");
      process.exit(1);
    }

    console.log("Testing WakaTime/Wakapi authentication...");
    try {
      const user = await wakaGet<{ data: { id: string; display_name?: string; username?: string } }>(
        config,
        "/users/current"
      );
      const name = user.data.display_name || user.data.username || user.data.id;
      console.log(`Authenticated as: ${name}`);
      console.log(`API URL: ${config.api_url}`);
    } catch (e) {
      console.error("Authentication failed:", e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  } else if (command === "help" || command === "-h" || command === "--help") {
    console.log(`WakaTime/Wakapi API Parser

Usage:
  bun run src/parsers/wakatime-api.ts [days]     # Sync last N days (default: 14)
  bun run src/parsers/wakatime-api.ts test       # Test API authentication
  bun run src/parsers/wakatime-api.ts status     # Check config status
  bun run src/parsers/wakatime-api.ts full       # Full sync (365 days)

Reads config from ~/.wakatime.cfg
`);
  } else if (command === "full") {
    await syncWakaTime("default", 365, true); // forceFullSync ignores existing data
  } else {
    const days = command ? parseInt(command, 10) : 14;
    await syncWakaTime("default", isNaN(days) ? 14 : days);
  }
}
