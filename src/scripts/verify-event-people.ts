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

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import { populateEventPeople } from "../db/queries";

interface VerificationResult {
  orphanedRows: number;
  staleRows: number;
  missingRows: number;
  mismatchedMetadata: number;
}

interface SampleMismatch {
  eventId: number;
  person: string;
  source: string;
  issue: string;
}

/**
 * Check 1: event_people rows without corresponding events (orphaned)
 */
function countOrphanedRows(db: Database): number {
  const result = db.prepare(`
    SELECT COUNT(*) as count
    FROM event_people ep
    WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = ep.event_id)
  `).get() as { count: number };
  return result.count;
}

/**
 * Check 2: event_people rows where person not in events.people JSON (stale)
 * This happens when a person was removed from events.people but the trigger failed
 */
function countStaleRows(db: Database): number {
  const result = db.prepare(`
    SELECT COUNT(*) as count
    FROM event_people ep
    JOIN events e ON e.id = ep.event_id
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(e.people, '[]')) p
      WHERE p.value = ep.person AND p.value IS NOT NULL AND p.value != ''
    )
  `).get() as { count: number };
  return result.count;
}

/**
 * Check 3: events.people values missing from event_people (missing)
 * This happens when a person was added to events.people but the trigger failed
 */
function countMissingRows(db: Database): number {
  const result = db.prepare(`
    SELECT COUNT(*) as count
    FROM events e, json_each(e.people) p
    WHERE e.people IS NOT NULL
      AND p.value IS NOT NULL
      AND p.value != ''
      AND NOT EXISTS (
        SELECT 1 FROM event_people ep
        WHERE ep.event_id = e.id AND ep.person = p.value
      )
  `).get() as { count: number };
  return result.count;
}

/**
 * Check 4: event_people rows with mismatched source/timestamp
 * This happens when events were updated but event_people wasn't
 */
function countMismatchedMetadata(db: Database): number {
  const result = db.prepare(`
    SELECT COUNT(*) as count
    FROM event_people ep
    JOIN events e ON e.id = ep.event_id
    WHERE ep.source != e.source
      OR (ep.timestamp IS NULL AND e.timestamp IS NOT NULL)
      OR (ep.timestamp IS NOT NULL AND e.timestamp IS NULL)
      OR ep.timestamp != e.timestamp
  `).get() as { count: number };
  return result.count;
}

/**
 * Get sample mismatches for debugging
 */
function getSampleMismatches(db: Database, limit: number = 10): SampleMismatch[] {
  const samples: SampleMismatch[] = [];

  // Sample orphaned rows
  const orphaned = db.prepare(`
    SELECT ep.event_id, ep.person, ep.source
    FROM event_people ep
    WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = ep.event_id)
    LIMIT ?
  `).all(limit) as Array<{ event_id: number; person: string; source: string }>;
  for (const row of orphaned) {
    samples.push({
      eventId: row.event_id,
      person: row.person,
      source: row.source,
      issue: "orphaned (event deleted)",
    });
  }

  // Sample stale rows
  const stale = db.prepare(`
    SELECT ep.event_id, ep.person, ep.source
    FROM event_people ep
    JOIN events e ON e.id = ep.event_id
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(e.people, '[]')) p
      WHERE p.value = ep.person AND p.value IS NOT NULL AND p.value != ''
    )
    LIMIT ?
  `).all(limit) as Array<{ event_id: number; person: string; source: string }>;
  for (const row of stale) {
    samples.push({
      eventId: row.event_id,
      person: row.person,
      source: row.source,
      issue: "stale (person removed from event)",
    });
  }

  // Sample missing rows
  const missing = db.prepare(`
    SELECT e.id as event_id, p.value as person, e.source
    FROM events e, json_each(e.people) p
    WHERE e.people IS NOT NULL
      AND p.value IS NOT NULL
      AND p.value != ''
      AND NOT EXISTS (
        SELECT 1 FROM event_people ep
        WHERE ep.event_id = e.id AND ep.person = p.value
      )
    LIMIT ?
  `).all(limit) as Array<{ event_id: number; person: string; source: string }>;
  for (const row of missing) {
    samples.push({
      eventId: row.event_id,
      person: row.person,
      source: row.source,
      issue: "missing (not in event_people)",
    });
  }

  // Sample mismatched metadata
  const mismatched = db.prepare(`
    SELECT ep.event_id, ep.person, ep.source, e.source as expected_source
    FROM event_people ep
    JOIN events e ON e.id = ep.event_id
    WHERE ep.source != e.source
      OR (ep.timestamp IS NULL AND e.timestamp IS NOT NULL)
      OR (ep.timestamp IS NOT NULL AND e.timestamp IS NULL)
      OR ep.timestamp != e.timestamp
    LIMIT ?
  `).all(limit) as Array<{ event_id: number; person: string; source: string; expected_source: string }>;
  for (const row of mismatched) {
    samples.push({
      eventId: row.event_id,
      person: row.person,
      source: row.source,
      issue: `metadata mismatch (source: ${row.source} vs ${row.expected_source})`,
    });
  }

  return samples;
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

    result = {
      orphanedRows: countOrphanedRows(db),
      staleRows: countStaleRows(db),
      missingRows: countMissingRows(db),
      mismatchedMetadata: countMismatchedMetadata(db),
    };

    duration = Date.now() - startTime;

    const checks = [
      { name: "Orphaned rows (event deleted)", count: result.orphanedRows },
      { name: "Stale rows (person removed)", count: result.staleRows },
      { name: "Missing rows (not indexed)", count: result.missingRows },
      { name: "Metadata mismatches", count: result.mismatchedMetadata },
    ];

    for (const check of checks) {
      const status = check.count === 0 ? "PASS" : "FAIL";
      console.log(`  ${check.name.padEnd(35)} ${formatCount(check.count).padStart(12)}  ${status}`);
    }

    console.log(`\n  Verification completed in ${duration}ms`);

    totalIssues = result.orphanedRows + result.staleRows + result.missingRows + result.mismatchedMetadata;
    hasIssues = totalIssues > 0;

    // Show sample mismatches if verbose and issues found
    if (verbose && hasIssues) {
      printSection("Sample Mismatches");
      const samples = getSampleMismatches(db, 5);
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
        postResult = {
          orphanedRows: countOrphanedRows(db),
          staleRows: countStaleRows(db),
          missingRows: countMissingRows(db),
          mismatchedMetadata: countMismatchedMetadata(db),
        };
        db.exec("COMMIT");
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors
        }
        throw err;
      }

      const postTotalIssues = postResult.orphanedRows + postResult.staleRows + postResult.missingRows + postResult.mismatchedMetadata;
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

main().catch((err) => {
  console.error("Verification failed with error:", err);
  process.exit(1);
});
