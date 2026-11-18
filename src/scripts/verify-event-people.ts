#!/usr/bin/env bun
/**
 * Verification and rebuild script for event_people table synchronization
 *
 * The event_people table is a denormalized index of events.people JSON arrays,
 * maintained by triggers. This script verifies synchronization and can rebuild
 * the table atomically if discrepancies are found.
 *
 * Usage:
 *   bun run src/scripts/verify-event-people.ts              # Verify only
 *   bun run src/scripts/verify-event-people.ts --verbose    # Show sample mismatches
 *   bun run src/scripts/verify-event-people.ts --rebuild    # Rebuild if discrepancies found
 *   bun run src/scripts/verify-event-people.ts --force-rebuild  # Always rebuild
 *
 * Exit codes:
 *   0 - All checks pass (or rebuild successful)
 *   1 - Discrepancies found (and --rebuild not specified)
 */

import { Database } from "../db/sqlite";
import { getDb, initDb } from "../db/schema";
import { populateEventPeople } from "../db/queries";

interface Check {
  label: string;
  from: string;
  where: string;
  /** Columns for a sample row: eventId, person, source and issue. */
  sample: string;
}

const EVENT_PEOPLE_WITH_EVENT = "event_people ep JOIN events e ON e.id = ep.event_id";

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
    where: `NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(e.people, '[]')) p
      WHERE p.value = ep.person AND p.value IS NOT NULL AND p.value != ''
    )`,
    sample: "ep.event_id AS eventId, ep.person, ep.source, 'stale (person removed from event)' AS issue",
  },
  // A person added to events.people whose row the trigger failed to insert
  missingRows: {
    label: "Missing rows (not indexed)",
    from: "events e, json_each(e.people) p",
    where: `e.people IS NOT NULL
      AND p.value IS NOT NULL
      AND p.value != ''
      AND NOT EXISTS (
        SELECT 1 FROM event_people ep
        WHERE ep.event_id = e.id AND ep.person = p.value
      )`,
    sample: "e.id AS eventId, p.value AS person, e.source, 'missing (not in event_people)' AS issue",
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

export type VerificationResult = Record<keyof typeof CHECKS, number>;

export interface SampleMismatch {
  eventId: number;
  person: string;
  source: string;
  issue: string;
}

/** Counts the rows that fail each check; all zeros means event_people matches events.people. */
export function verifyEventPeople(db: Database): VerificationResult {
  return Object.fromEntries(
    Object.entries(CHECKS).map(([name, check]) => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${check.from} WHERE ${check.where}`).get() as { count: number };
      return [name, row.count];
    }),
  ) as VerificationResult;
}

/** Up to `limit` failing rows per check, in check order. */
export function sampleMismatches(db: Database, limit: number): SampleMismatch[] {
  return Object.values(CHECKS).flatMap(
    (check) => db.prepare(`SELECT ${check.sample} FROM ${check.from} WHERE ${check.where} LIMIT ?`).all(limit) as SampleMismatch[],
  );
}

function issueCount(result: VerificationResult): number {
  return Object.values(result).reduce((sum, count) => sum + count, 0);
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

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const rebuild = args.includes("--rebuild");
  const forceRebuild = args.includes("--force-rebuild");
  const shouldRebuild = rebuild || forceRebuild;

  console.log("event_people Table Verification");
  console.log("================================");
  console.log(`Date: ${new Date().toISOString()}`);

  const db = getDb();

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
  let hasIssues: boolean;
  let totalIssues: number;

  db.exec("BEGIN");
  try {
    // Get statistics
    stats = getStatistics(db);
    console.log(`\nTable Statistics:`);
    console.log(`  Events total:        ${formatCount(stats.eventCount)}`);
    console.log(`  Events with people:  ${formatCount(stats.eventsWithPeople)}`);
    console.log(`  event_people rows:   ${formatCount(stats.eventPeopleCount)}`);

    // Run verification checks
    printSection("Verification Checks");

    console.log("\nRunning checks (this may take a moment for large databases)...\n");

    const startTime = Date.now();

    result = verifyEventPeople(db);

    duration = Date.now() - startTime;

    for (const [name, check] of Object.entries(CHECKS) as Array<[keyof typeof CHECKS, Check]>) {
      const count = result[name];
      const status = count === 0 ? "PASS" : "FAIL";
      console.log(`  ${check.label.padEnd(35)} ${formatCount(count).padStart(12)}  ${status}`);
    }

    console.log(`\n  Verification completed in ${duration}ms`);

    totalIssues = issueCount(result);
    hasIssues = totalIssues > 0;

    // Show sample mismatches if verbose and issues found
    if (verbose && hasIssues) {
      printSection("Sample Mismatches");
      const samples = sampleMismatches(db, 5);
      for (const sample of samples) {
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

  // Track final issue state (may be updated after rebuild)
  let finalHasIssues = hasIssues;
  let finalIssueCount = totalIssues;
  let rebuildRan = false;

  // Handle rebuild
  if (forceRebuild || (rebuild && hasIssues)) {
    rebuildRan = true;
    printSection("Rebuilding event_people Table");

    console.log("\nPerforming atomic rebuild...");
    const rebuildStart = Date.now();

    try {
      const newCount = populateEventPeople(db);
      const rebuildDuration = Date.now() - rebuildStart;

      console.log(`\nRebuild completed in ${rebuildDuration}ms`);
      console.log(`  New row count: ${formatCount(newCount)}`);

      // Re-verify after rebuild
      console.log("\nRe-verifying after rebuild...");
      db.exec("BEGIN");
      let postResult: VerificationResult;
      try {
        postResult = verifyEventPeople(db);
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors
        }
        throw err;
      }

      const postTotalIssues = issueCount(postResult);
      finalHasIssues = postTotalIssues > 0;
      finalIssueCount = postTotalIssues;

      if (postTotalIssues === 0) {
        console.log("  All checks now pass.");
      } else {
        console.log(`  WARNING: ${postTotalIssues} issues remain after rebuild`);
      }
    } catch (err) {
      console.error("\nRebuild failed:", err);
      db.close();
      process.exit(1);
    }
  } else if (hasIssues && !rebuild) {
    printSection("Action Required");
    console.log(`\nFound ${formatCount(totalIssues)} total discrepancies.`);
    console.log("Run with --rebuild to fix, or --verbose to see samples.");
  }

  printSection("Summary");

  if (finalHasIssues) {
    console.log("\nVERIFICATION FAILED");
    if (rebuildRan) {
      console.log(`${formatCount(finalIssueCount)} discrepancies remain after rebuild.`);
      console.log("This may indicate a bug in the rebuild logic or corrupted data.");
    } else {
      console.log(`${formatCount(finalIssueCount)} discrepancies found between events.people and event_people table.`);
      console.log("\nTo fix: bun run src/scripts/verify-event-people.ts --rebuild");
    }
  } else {
    console.log("\nVERIFICATION PASSED");
    console.log("event_people table is synchronized with events.people.");
  }
  console.log("=".repeat(70));

  db.close();
  process.exit(finalHasIssues ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Verification failed with error:", err);
    process.exit(1);
  });
}
