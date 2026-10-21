#!/usr/bin/env bun
/**
 * Reimport facebook export packages to refresh raw_data (and with it
 * conversation_id) on existing rows via the parser's upsert path.
 *
 * Pass the export roots OLDEST FIRST: the upsert is last-writer-wins, so
 * rows that survive into newer exports end up carrying the newer export's
 * thread_path (the numeric-id era), and only rows exclusive to an older
 * export keep its folder naming.
 *
 * A full reimport can upsert many message rows, so every per-row AFTER UPDATE
 * trigger is dropped for the run and its table rebuilt once at the end:
 * - conversation summaries via withBulkSummaryRebuild (quadratic per-row
 *   recompute; emptied tables double as the crash marker initDb() heals);
 * - event_people + identity event counts (cost scales with the people array,
 *   and large group threads rewrite many rows per message) rebuilt by
 *   populateEventPeople's atomic swap;
 * - the events_au FTS sync trigger, rebuilt with FTS5's 'rebuild' command
 *   (events_fts is content=events). If a run is interrupted the triggers
 *   come back via initDb() but FTS keeps pre-run text for already-updated
 *   rows — rerun this script to completion to fix that.
 *
 * Usage:
 *   bun run src/scripts/facebook-reimport.ts --account <name> <oldest-export-root> [<newer-export-root> ...]
 *
 * Each export root is the directory containing `messages/` or
 * `your_facebook_activity/messages/`.
 */

import { dropEventPeopleTriggers, getDb, initDb } from "../db/schema";
import { withBulkSummaryRebuild } from "../db/bulk-summary-rebuild";
import { populateEventPeople } from "../db/event-people";
import { importFacebookData } from "../parsers/facebook";

function parseArgs(argv: string[]): { account: string; paths: string[] } {
  const paths: string[] = [];
  let account: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--account") account = argv[++i] ?? null;
    else paths.push(argv[i]);
  }
  if (!account || paths.length === 0) {
    console.log(
      "Usage: bun run src/scripts/facebook-reimport.ts --account <name> <oldest-export-root> [<newer-export-root> ...]"
    );
    process.exit(1);
  }
  return { account, paths };
}

const { account, paths } = parseArgs(process.argv.slice(2));

const db = getDb();
initDb(db);

console.log("============================================================");
console.log("Facebook reimport (oldest export first)");
console.log("============================================================");
console.log(`Account: ${account}`);
console.log(`Exports (in order): \n  ${paths.join("\n  ")}`);

const t0 = Date.now();
await withBulkSummaryRebuild(db, async () => {
  dropEventPeopleTriggers(db);
  db.exec("DROP TRIGGER IF EXISTS events_au");

  for (const path of paths) {
    console.log(`\n--- Importing ${path} ---`);
    await importFacebookData(db, path, account);
  }

  console.log("\nRebuilding event_people and identity event counts...");
  const peopleRows = populateEventPeople(db);
  console.log(`  ${peopleRows.toLocaleString()} event_people rows`);

  console.log("Rebuilding events_fts...");
  db.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`);

  console.log("Restoring triggers and rebuilding conversation summaries...");
});

console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)}s.`);
db.close();
