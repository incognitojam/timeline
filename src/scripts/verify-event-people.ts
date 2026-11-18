#!/usr/bin/env bun
/**
 * Verification and rebuild script for event_people table synchronization
 *
 * The event_people table holds the rows eventPeopleRowsSql derives from
 * events.people, maintained by triggers. This script verifies synchronization
 * and can rebuild the table atomically if discrepancies are found.
 *
 * Usage:
 *   bun run src/scripts/verify-event-people.ts              # Verify only
 *   bun run src/scripts/verify-event-people.ts --verbose    # Show sample mismatches
 *   bun run src/scripts/verify-event-people.ts --rebuild    # Rebuild if discrepancies found
 *   bun run src/scripts/verify-event-people.ts --force-rebuild  # Always rebuild
 *
 * Exit codes:
 *   0 - All checks pass (or the rebuild committed and verified clean)
 *   1 - Discrepancies found and not rebuilt, or stopped before any rebuild (no
 *       database, no events, SQLite too old, or an error); the table is unchanged
 *   2 - The rebuild failed and rolled back: the old table is intact
 *   3 - The rebuild committed, but verifying it found issues or failed
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getTimelineDbPath } from "../db/paths";
import { Database } from "../db/sqlite";
import { eventIndexesEveryone, eventPeopleRowsSql, getDb, initDb } from "../db/schema";
import { populateEventPeople } from "../db/queries";
import { configureBunSqliteForSqliteVec, loadedSqliteLibraryPath } from "../embeddings/sqlite-vec";

interface Check {
  label: string;
  from: string;
  where: string;
  /** Columns for a sample row: eventId, person, source and issue. */
  sample: string;
}

const EVENT_PEOPLE_WITH_EVENT = "event_people ep JOIN events e ON e.id = ep.event_id";
const LISTED = `EXISTS (
      SELECT 1 FROM json_each(COALESCE(e.people, '[]')) p
      WHERE p.value = ep.person AND p.value IS NOT NULL AND p.value != ''
    )`;

const CHECKS = {
  // A row whose event no longer exists
  orphanedRows: {
    label: "Orphaned rows (event deleted)",
    from: "event_people ep",
    where: "NOT EXISTS (SELECT 1 FROM events e WHERE e.id = ep.event_id)",
    sample: "ep.event_id AS eventId, ep.person, ep.source, 'orphaned (event deleted)' AS issue",
  },
  // A person removed from events.people whose row the trigger failed to delete
  staleRows: {
    label: "Stale rows (person removed)",
    from: EVENT_PEOPLE_WITH_EVENT,
    where: `NOT ${LISTED}`,
    sample: "ep.event_id AS eventId, ep.person, ep.source, 'stale (person removed from event)' AS issue",
  },
  // A person added to events.people whose row the trigger failed to insert
  missingRows: {
    label: "Missing rows (not indexed)",
    from: `(${eventPeopleRowsSql("events e")}) x`,
    where: "NOT EXISTS (SELECT 1 FROM event_people ep WHERE ep.event_id = x.event_id AND ep.person = x.person)",
    sample: "x.event_id AS eventId, x.person, x.source, 'missing (not in event_people)' AS issue",
  },
  // A row whose source or timestamp no longer matches its event
  mismatchedMetadata: {
    label: "Metadata mismatches",
    from: EVENT_PEOPLE_WITH_EVENT,
    where: `ep.source != e.source
      OR (ep.timestamp IS NULL AND e.timestamp IS NOT NULL)
      OR (ep.timestamp IS NOT NULL AND e.timestamp IS NULL)
      OR ep.timestamp != e.timestamp`,
    sample: "ep.event_id AS eventId, ep.person, ep.source, 'metadata mismatch (source: ' || ep.source || ' vs ' || e.source || ')' AS issue",
  },
} as const satisfies Record<string, Check>;

// Rows for people a group message still lists after its sender: its members,
// indexed before only the sender of a group message was. Not drift; a rebuild
// drops them. Counted per group message, which decides the rule once and finds
// each listed member by primary key.
const ROWS_BEFORE_SENDER_RULE = `
  SELECT COALESCE(SUM((
    SELECT COUNT(DISTINCT p.value) FROM json_each(e.people) p
    WHERE p.key > 0 AND p.value IS NOT NULL AND p.value != '' AND p.value IS NOT e.people ->> 0
      AND EXISTS (SELECT 1 FROM event_people ep WHERE ep.event_id = e.id AND ep.person = p.value)
  )), 0) AS count
  FROM events e
  WHERE e.people IS NOT NULL AND NOT (${eventIndexesEveryone("e")})`;

export type VerificationResult = Record<keyof typeof CHECKS, number> & { rowsBeforeSenderRule: number };

export interface SampleMismatch {
  eventId: number;
  person: string;
  source: string;
  issue: string;
}

/**
 * Counts the rows that fail each check, plus the rows from before the sender
 * rule; zero issues means event_people matches events.people.
 */
export function verifyEventPeople(db: Database): VerificationResult {
  const count = (from: string, where: string) =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${from} WHERE ${where}`).get() as { count: number }).count;
  return {
    ...(Object.fromEntries(
      Object.entries(CHECKS).map(([name, check]) => [name, count(check.from, check.where)]),
    ) as Record<keyof typeof CHECKS, number>),
    rowsBeforeSenderRule: (db.prepare(ROWS_BEFORE_SENDER_RULE).get() as { count: number }).count,
  };
}

/** Up to `limit` failing rows per check, in check order. */
export function sampleMismatches(db: Database, limit: number): SampleMismatch[] {
  return Object.values(CHECKS).flatMap(
    (check) => db.prepare(`SELECT ${check.sample} FROM ${check.from} WHERE ${check.where} LIMIT ?`).all(limit) as SampleMismatch[],
  );
}

/** Drift that --rebuild repairs. Rows from before the sender rule are not drift. */
export function issueCount(result: VerificationResult): number {
  return (Object.keys(CHECKS) as Array<keyof typeof CHECKS>).reduce((sum, name) => sum + result[name], 0);
}

/**
 * Get table statistics for reporting
 */
function getStatistics(db: Database): { eventCount: number; eventPeopleCount: number; eventsWithPeople: number } {
  const eventCount = (db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number }).count;
  const eventPeopleCount = (db.prepare("SELECT COUNT(*) as count FROM event_people").get() as { count: number }).count;
  const eventsWithPeople = (db.prepare("SELECT COUNT(*) as count FROM events WHERE people IS NOT NULL").get() as { count: number }).count;
  return { eventCount, eventPeopleCount, eventsWithPeople };
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function printSection(title: string): void {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

/** A clean result: no drift and no rows from before the sender rule. */
export function isClean(result: VerificationResult): boolean {
  return issueCount(result) === 0 && result.rowsBeforeSenderRule === 0;
}

export type RebuildOutcome =
  /** populateEventPeople threw; its transaction rolled back, so the old table is intact. */
  | { kind: "rolled-back"; error: unknown }
  /** The rebuild committed and was verified; `after` may still show issues. */
  | { kind: "committed"; rows: number; after: VerificationResult }
  /** The rebuild committed, but verifying it threw. */
  | { kind: "committed-unverified"; rows: number; error: unknown };

/** Rebuild, then verify the committed result, keeping the two failures apart. */
export function rebuildAndVerify(db: Database, verify: (db: Database) => VerificationResult = verifyEventPeople): RebuildOutcome {
  let rows: number;
  try {
    rows = populateEventPeople(db);
  } catch (error) {
    return { kind: "rolled-back", error };
  }
  try {
    return { kind: "committed", rows, after: verify(db) };
  } catch (error) {
    return { kind: "committed-unverified", rows, error };
  }
}

/** The oldest SQLite the people index's SQL runs on: it uses the ->> operator. */
const MINIMUM_SQLITE_VERSION = "3.38.0";

/** Refuse a SQLite older than the minimum, before any of its SQL fails part-way. */
export function assertSqliteVersion(version: string): void {
  const parts = (v: string) => v.split(".").map(Number);
  const [have, need] = [parts(version), parts(MINIMUM_SQLITE_VERSION)];
  for (let i = 0; i < need.length; i++) {
    if ((have[i] ?? 0) !== need[i]) {
      if ((have[i] ?? 0) > need[i]) return;
      throw new Error(`SQLite ${version} is older than ${MINIMUM_SQLITE_VERSION}, which the people index needs. Set TIMELINE_SQLITE_LIBRARY_PATH to a newer library.`);
    }
  }
}

/** The SQLite this process loaded, to compare with the service's; refuses one too old. */
export function sqliteDescription(db: Database): string {
  const { version } = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
  assertSqliteVersion(version);
  return `${version} from ${loadedSqliteLibraryPath() ?? "Bun's default library"}`;
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const rebuild = args.includes("--rebuild");
  const forceRebuild = args.includes("--force-rebuild");
  const shouldRebuild = rebuild || forceRebuild;

  console.log("event_people Table Verification");
  console.log("================================");
  console.log(`Date: ${new Date().toISOString()}`);

  // Use the SQLite library the service uses, chosen before any database opens.
  configureBunSqliteForSqliteVec();
  const path = resolve(getTimelineDbPath());
  if (!existsSync(path)) {
    console.error(`No database at ${path}. Set TIMELINE_DB_PATH to the database to check.`);
    process.exit(1);
  }
  const db = getDb();
  const events = (db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count;
  console.log(`Database: ${path}`);
  console.log(`Events:   ${formatCount(events)}`);
  console.log(`SQLite:   ${sqliteDescription(db)}`);
  if (shouldRebuild && events === 0) {
    console.error(`\nRefusing to rebuild: ${path} has no events. Check TIMELINE_DB_PATH.`);
    db.close();
    process.exit(1);
  }

  if (shouldRebuild) {
    db.exec("BEGIN IMMEDIATE");
    try {
      initDb(db);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback errors
      }
      throw err;
    }
  } else {
    const tableRow = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'event_people'
    `).get() as { name?: string } | undefined;
    if (!tableRow?.name) {
      console.error("event_people table not found.");
      console.error("Run with --rebuild or --force-rebuild to create and populate it.");
      db.close();
      process.exit(1);
    }
  }

  let stats: { eventCount: number; eventPeopleCount: number; eventsWithPeople: number };
  let result: VerificationResult;
  let duration: number;

  db.exec("BEGIN");
  try {
    stats = getStatistics(db);
    console.log(`\nTable Statistics:`);
    console.log(`  Events total:        ${formatCount(stats.eventCount)}`);
    console.log(`  Events with people:  ${formatCount(stats.eventsWithPeople)}`);
    console.log(`  event_people rows:   ${formatCount(stats.eventPeopleCount)}`);

    printSection("Verification Checks");
    console.log("\nRunning checks (this may take a moment for large databases)...\n");
    const startTime = Date.now();
    result = verifyEventPeople(db);
    duration = Date.now() - startTime;
    printResult(result);
    console.log(`\n  Verification completed in ${duration}ms`);

    if (verbose && issueCount(result) > 0) {
      printSection("Sample Mismatches");
      for (const sample of sampleMismatches(db, 5)) {
        console.log(`  Event ${sample.eventId}: ${sample.person} (${sample.source})`);
        console.log(`    Issue: ${sample.issue}`);
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    throw err;
  }

  const totalIssues = issueCount(result);

  if (forceRebuild || (rebuild && totalIssues > 0)) {
    printSection("Rebuilding event_people Table");
    console.log("\nRebuilding in one transaction...");
    const rebuildStart = Date.now();
    const outcome = rebuildAndVerify(db);
    db.close();
    printSection("Summary");
    if (outcome.kind === "rolled-back") {
      console.error("\nREBUILD FAILED AND ROLLED BACK: the old table is intact.");
      console.error(outcome.error);
      process.exit(2);
    }
    console.log(`\nRebuild committed in ${Date.now() - rebuildStart}ms`);
    console.log(`  New row count: ${formatCount(outcome.rows)}`);
    if (outcome.kind === "committed-unverified") {
      console.error("\nREBUILD COMMITTED, BUT VERIFYING IT FAILED: the new table is in place and unverified.");
      console.error(outcome.error);
      process.exit(3);
    }
    printResult(outcome.after);
    if (!isClean(outcome.after)) {
      console.error("\nREBUILD COMMITTED, BUT VERIFYING IT FOUND ISSUES: the new table is in place.");
      process.exit(3);
    }
    console.log("\nREBUILD COMMITTED AND VERIFIED: all checks pass.");
    process.exit(0);
  }

  printSection("Summary");
  if (totalIssues > 0) {
    console.log("\nVERIFICATION FAILED");
    console.log(`${formatCount(totalIssues)} discrepancies found between events.people and event_people table.`);
    console.log("Run with --verbose to see samples; --rebuild rebuilds the whole table.");
  } else {
    console.log("\nVERIFICATION PASSED");
    console.log("event_people table is synchronized with events.people.");
  }
  if (result.rowsBeforeSenderRule > 0) {
    console.log("\nThe table predates the rule that indexes only the sender of a group message:");
    console.log(`${formatCount(result.rowsBeforeSenderRule)} rows still index group members. They are not drift, but the`);
    console.log("table needs a rebuild to drop them. --rebuild does not rebuild for them; use --force-rebuild.");
  }
  console.log("=".repeat(70));

  db.close();
  process.exit(totalIssues > 0 ? 1 : 0);
}

function printResult(result: VerificationResult): void {
  for (const [name, check] of Object.entries(CHECKS) as Array<[keyof typeof CHECKS, Check]>) {
    const count = result[name];
    console.log(`  ${check.label.padEnd(35)} ${formatCount(count).padStart(12)}  ${count === 0 ? "PASS" : "FAIL"}`);
  }
  if (result.rowsBeforeSenderRule > 0) {
    console.log(`  ${"Member rows from before the rule".padEnd(35)} ${formatCount(result.rowsBeforeSenderRule).padStart(12)}  REBUILD NEEDED`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Verification failed with error:", err);
    process.exit(1);
  });
}
