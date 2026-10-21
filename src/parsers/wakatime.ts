/**
 * WakaTime Parser
 *
 * Imports WakaTime export data and aggregates heartbeats into coding sessions.
 * WakaTime sends "heartbeats" every ~2 minutes while coding. This parser groups
 * them into sessions based on time gaps.
 *
 * Session boundary: 15 minutes of inactivity
 * Duration calculation: Sum of gaps between heartbeats, capped at 2 min each
 *
 * Event types created:
 * - code:session - Aggregated coding sessions (default)
 * - code:heartbeat - Raw heartbeats (with --include-heartbeats flag)
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import {
  aggregateIntoSessions,
  buildSessionMetadata,
  generateSessionContent,
  generateSessionTitle,
  SESSION_TIMEOUT_MINUTES,
  type Session,
} from "../lib/wakatime";

// WakaTime export structure
interface WakaTimeHeartbeat {
  branch: string | null;
  category: string;
  created_at: string;
  cursorpos: number | null;
  dependencies: string[];
  entity: string;
  id: string;
  is_write: boolean;
  language: string;
  line_additions: number | null;
  line_deletions: number | null;
  lineno: number | null;
  lines: number | null;
  machine_name_id: string;
  project: string | null;
  project_root_count: number | null;
  time: number; // Unix timestamp
  type: string;
  user_agent_id: string;
  user_id: string;
}

interface WakaTimeDay {
  date: string;
  heartbeats: WakaTimeHeartbeat[];
}

interface WakaTimeExport {
  user: Record<string, unknown>;
  range: { start: number; end: number };
  days: WakaTimeDay[];
}

async function importWakaTime(
  db: Database,
  exportPath: string,
  sourceAccount: string,
  includeHeartbeats: boolean
) {
  const importBatch = `wakatime-${sourceAccount}-${Date.now()}`;

  console.log(`Loading WakaTime export from ${exportPath}...`);
  const data: WakaTimeExport = await Bun.file(exportPath).json();

  console.log(`Date range: ${new Date(data.range.start * 1000).toISOString().split("T")[0]} to ${new Date(data.range.end * 1000).toISOString().split("T")[0]}`);
  console.log(`Total days: ${data.days.length}`);

  // Collect all heartbeats
  const allHeartbeats = data.days.flatMap((d) => d.heartbeats);
  console.log(`Total heartbeats: ${allHeartbeats.length}`);

  // Aggregate into sessions
  console.log(`\nAggregating into sessions (${SESSION_TIMEOUT_MINUTES}-minute timeout)...`);
  const sessions = aggregateIntoSessions(allHeartbeats);
  console.log(`Created ${sessions.length} sessions`);

  // Stats
  const totalDuration = sessions.reduce((sum, s) => sum + s.durationMs, 0);
  const avgDuration = sessions.length > 0 ? totalDuration / sessions.length : 0;
  console.log(`Total coding time: ${(totalDuration / 1000 / 60 / 60).toFixed(1)} hours`);
  console.log(`Average session: ${(avgDuration / 1000 / 60).toFixed(1)} minutes`);

  // Prepare insert statements
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertHeartbeat = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let sessionsImported = 0;
  let heartbeatsImported = 0;
  let skipped = 0;

  // Import sessions
  console.log("\nImporting sessions...");
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
        insertSession.run(
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
        sessionsImported++;
      } catch (e) {
        skipped++;
      }
    }
  });

  insertSessions(sessions);
  console.log(`Imported ${sessionsImported} sessions`);

  // Optionally import raw heartbeats
  if (includeHeartbeats) {
    console.log("\nImporting raw heartbeats...");
    const batchSize = 10000;

    for (let i = 0; i < allHeartbeats.length; i += batchSize) {
      const batch = allHeartbeats.slice(i, i + batchSize);

      const insertBatch = db.transaction((heartbeats: WakaTimeHeartbeat[]) => {
        for (const hb of heartbeats) {
          const timestamp = new Date(hb.time * 1000).toISOString();
          // Extract filename from path
          const filename = hb.entity.split(/[/\\]/).pop() || hb.entity;
          const title = `${hb.project || "Unknown"}: ${filename}`;
          const content = `${hb.language || "Unknown"} - ${hb.entity}`;

          const tags: string[] = [];
          if (hb.language) tags.push(`language:${hb.language}`);
          if (hb.project) tags.push(`project:${hb.project}`);
          if (hb.branch) tags.push(`branch:${hb.branch}`);
          if (hb.category && hb.category !== "coding") tags.push(`category:${hb.category}`);
          if (hb.machine_name_id) tags.push(`machine:${hb.machine_name_id}`);
          if (hb.is_write) tags.push("write");

          try {
            insertHeartbeat.run(
              "wakatime",
              `heartbeat:${hb.id}`,
              sourceAccount,
              "code:heartbeat",
              timestamp,
              title,
              content,
              JSON.stringify(tags),
              JSON.stringify(hb),
              importBatch
            );
            heartbeatsImported++;
          } catch (e) {
            skipped++;
          }
        }
      });

      insertBatch(batch);

      if ((i + batchSize) % 100000 === 0 || i + batchSize >= allHeartbeats.length) {
        console.log(`  Processed ${Math.min(i + batchSize, allHeartbeats.length)}/${allHeartbeats.length} heartbeats`);
      }
    }

    console.log(`Imported ${heartbeatsImported} heartbeats`);
  }

  console.log(`\nImport complete:`);
  console.log(`  Sessions: ${sessionsImported}`);
  if (includeHeartbeats) {
    console.log(`  Heartbeats: ${heartbeatsImported}`);
  }
  console.log(`  Skipped: ${skipped} (duplicates)`);
  console.log(`  Batch ID: ${importBatch}`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/wakatime.ts <export-file> [account-name] [--include-heartbeats]");
  console.log("");
  console.log("Options:");
  console.log("  --include-heartbeats  Also import individual heartbeats (can add many events)");
  console.log("");
  console.log("Examples:");
  console.log("  bun run src/parsers/wakatime.ts ./imports/wakatime-export.json");
  console.log("  bun run src/parsers/wakatime.ts ./imports/wakatime-export.json my-account --include-heartbeats");
  process.exit(1);
}

const exportPath = args[0];
const includeHeartbeats = args.includes("--include-heartbeats");
const accountName = args.find((a) => a !== exportPath && !a.startsWith("--")) || "default";

const db = getDb();
initDb(db);

await importWakaTime(db, exportPath, accountName, includeHeartbeats);

db.close();
