#!/usr/bin/env bun
/**
 * Sample Database
 *
 * Creates a smaller sample database from a source Timeline database with
 * guaranteed coverage of every (source, type) combination.
 *
 * Usage: bun run src/scripts/sample-database.ts <source-db> <output-db> [--percent=1] [--min-per-type=5] [--no-contacts] [--verbose]
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import type { TimelineEvent } from "../db/schema";

function time<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  console.log(`  [${label}] ${(elapsed / 1000).toFixed(2)}s`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);

  const positional = args.filter((a) => !a.startsWith("--"));
  const verbose = args.includes("--verbose");
  const noContacts = args.includes("--no-contacts");

  const percentArg = args.find((a) => a.startsWith("--percent="));
  const percent = percentArg ? Number(percentArg.split("=")[1]) : 1;

  const minArg = args.find((a) => a.startsWith("--min-per-type="));
  const minPerType = minArg ? Number(minArg.split("=")[1]) : 5;

  if (positional.length < 2) {
    console.error(
      "Usage: bun run src/scripts/sample-database.ts <source-db> <output-db> [--percent=1] [--min-per-type=5] [--no-contacts] [--verbose]"
    );
    process.exit(1);
  }

  const [sourcePath, outputPath] = positional;

  if (!existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }

  if (existsSync(outputPath)) {
    throw new Error(
      `Output database already exists: ${outputPath} (delete it first)`
    );
  }

  // Open source DB (not readonly - we need temp tables and ATTACH)
  const sourceDb = new Database(sourcePath);

  // Count total events
  const { total } = sourceDb
    .prepare(`SELECT COUNT(*) as total FROM events`)
    .get() as { total: number };

  console.log(`Source database: ${total.toLocaleString()} events`);

  // Phase 1: discover all (source, type) pairs
  const pairs = sourceDb
    .prepare(
      `SELECT source, type, COUNT(*) as count FROM events GROUP BY source, type`
    )
    .all() as { source: string; type: string; count: number }[];

  console.log(`Found ${pairs.length} distinct (source, type) pairs`);

  // Phase 1: sample min-per-type events from each pair
  const coverageIds = new Set<number>();
  time("Phase 1: coverage sampling", () => {
    const coverageStmt = sourceDb.prepare(
      `SELECT id FROM events WHERE source = ? AND type = ? ORDER BY RANDOM() LIMIT ?`
    );

    for (const pair of pairs) {
      const limit = Math.min(minPerType, pair.count);
      const rows = coverageStmt.all(pair.source, pair.type, limit) as {
        id: number;
      }[];
      for (const row of rows) {
        coverageIds.add(row.id);
      }
    }
  });

  console.log(
    `Phase 1 (coverage): ${coverageIds.size.toLocaleString()} events`
  );

  // Phase 2: compute fill budget
  const budget = Math.max(
    0,
    Math.floor((total * percent) / 100) - coverageIds.size
  );

  // Phase 2: random fill using modulo sampling (much faster than ORDER BY RANDOM)
  let fillIds: number[] = [];
  if (budget > 0) {
    time("Phase 2: modulo sampling", () => {
      // Calculate modulo threshold to get approximately the right number of events
      // We need `budget` more events out of `total - coverageIds.size` remaining
      const remaining = total - coverageIds.size;
      const moduloThreshold = Math.ceil((budget / remaining) * 1000);

      // Build an exclusion set for the WHERE clause
      const excludeTable = `_exclude_ids`;
      sourceDb.exec(`CREATE TEMP TABLE ${excludeTable} (id INTEGER PRIMARY KEY)`);
      const insertExclude = sourceDb.prepare(
        `INSERT INTO ${excludeTable} VALUES (?)`
      );
      sourceDb.exec("BEGIN");
      for (const id of coverageIds) {
        insertExclude.run(id);
      }
      sourceDb.exec("COMMIT");

      // Use modulo sampling instead of ORDER BY RANDOM() - O(n) scan vs O(n log n) sort
      const fillRows = sourceDb
        .prepare(
          `SELECT id FROM events WHERE id NOT IN (SELECT id FROM ${excludeTable}) AND (id % 1000) < ?`
        )
        .all(moduloThreshold) as { id: number }[];
      fillIds = fillRows.map((r) => r.id);

      sourceDb.exec(`DROP TABLE ${excludeTable}`);
    });
  }

  console.log(`Phase 2 (random fill): ${fillIds.length.toLocaleString()} events`);

  const allIds = [...coverageIds, ...fillIds];
  console.log(`Total sample: ${allIds.length.toLocaleString()} events`);

  // Create output DB with schema
  // Dynamic import avoids schema.ts module-level side effects (TIMELINE_DB_PATH check)
  process.env.TIMELINE_DB_PATH = sourcePath;
  const { initDb } = await import("../db/schema");
  const outputDb = new Database(outputPath);
  outputDb.exec("PRAGMA journal_mode = WAL");
  initDb(outputDb);

  // Bulk copy events using ATTACH DATABASE (much faster than row-by-row)
  time("Bulk insert: prep temp table", () => {
    sourceDb.exec(`CREATE TEMP TABLE _sample_ids (id INTEGER PRIMARY KEY)`);
    const insertId = sourceDb.prepare(`INSERT INTO _sample_ids VALUES (?)`);
    sourceDb.exec("BEGIN");
    for (const id of allIds) {
      insertId.run(id);
    }
    sourceDb.exec("COMMIT");
  });

  // Attach output DB to source and bulk insert
  sourceDb.exec(`ATTACH DATABASE '${outputPath}' AS output`);

  // Disable derived indexes that are rebuilt in bulk after the insert. These
  // trigger drops must use sourceDb because it owns the ATTACH.
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.events_ai`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.events_ad`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.events_au`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.events_people_ai`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.events_people_ad`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.events_people_au_delete`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.events_people_au_insert`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.event_day_sources_ai`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.event_day_sources_ad`);
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.event_day_sources_au`);
  // The timestamp guard fires per row on INSERT...SELECT and would abort the
  // copy on any legacy bare-date row still in the source. initDb re-creates it
  // the next time the sample is opened.
  sourceDb.exec(`DROP TRIGGER IF EXISTS output.events_timestamp_iso`);
  time("Bulk insert: INSERT...SELECT", () => {
    sourceDb.exec(`
      INSERT INTO output.events (
        source, source_id, source_account, type,
        timestamp, end_timestamp, duration_ms,
        title, content,
        latitude, longitude, location_name,
        people, tags, raw_data,
        imported_at, import_batch, conversation_id
      )
      SELECT
        e.source, e.source_id, e.source_account, e.type,
        e.timestamp, e.end_timestamp, e.duration_ms,
        e.title, e.content,
        e.latitude, e.longitude, e.location_name,
        e.people, e.tags, e.raw_data,
        e.imported_at, e.import_batch, e.conversation_id
      FROM main.events e
      WHERE e.id IN (SELECT id FROM _sample_ids)
    `);
  });

  sourceDb.exec(`DROP TABLE _sample_ids`);
  sourceDb.exec(`DETACH DATABASE output`);
  // Source is no longer read via this handle; the contact copy below re-attaches
  // the source file to the output connection so its triggers fire in-context.
  sourceDb.close();

  time("Restore triggers and date summaries", () => initDb(outputDb));

  time("Rebuild FTS index", () => {
    outputDb.exec(`INSERT INTO events_fts(events_fts) VALUES('rebuild')`);
  });

  time("Rebuild event_people index", () => {
    outputDb.exec(`DELETE FROM event_people`);
    outputDb.exec(`
      INSERT OR IGNORE INTO event_people (event_id, person, source, timestamp, is_sender)
      SELECT events.id, json_each.value, events.source, events.timestamp,
             CASE WHEN json_each.key = 0 THEN 1 ELSE 0 END
      FROM events, json_each(events.people)
      WHERE events.people IS NOT NULL AND events.people != '[]'
    `);
  });

  const inserted = allIds.length;
  console.log(`\nInserted ${inserted.toLocaleString()} events into ${outputPath}`);

  // Phase 3: Copy contact data. The contacts, their memories, and platform
  // identities are tiny reference tables next to events, so we copy them in
  // full rather than sampling — that gives complete contact and identity
  // resolution locally instead of the orphaned subset a sample would leave.
  // Insert contacts before their children so the contact_id foreign keys
  // resolve.
  //
  // event_count is deliberately omitted from the identities copy: the live
  // identities_ai_event_count trigger recomputes it from the sampled
  // event_people rebuilt above. Copying prod's value would report counts for
  // events that aren't in the sample. normalized_name IS copied so its
  // maintenance trigger stays a no-op.
  //
  // --no-contacts skips this copy entirely. These tables concentrate the
  // database's PII (names, notes, dates of birth, AI-stored memories), so a
  // contactless sample is the one to share or screenshot.
  if (noContacts) {
    console.log(`\nSkipping contact tables (--no-contacts)`);
  } else {
    console.log(`\nCopying contact tables...`);

    let contactsCopied = 0;
    let memoriesCopied = 0;
    let identitiesCopied = 0;
    time("Copy contact tables", () => {
      // ATTACH/DETACH must run outside a transaction.
      outputDb.exec(`ATTACH DATABASE '${sourcePath}' AS src`);
      outputDb.exec("BEGIN");
      outputDb.exec(`
        INSERT INTO contacts (id, display_name, notes, date_of_birth, hidden, is_self, created_at, updated_at)
        SELECT id, display_name, notes, date_of_birth, hidden, is_self, created_at, updated_at
        FROM src.contacts
      `);
      outputDb.exec(`
        INSERT INTO contact_memories (id, contact_id, content, created_at)
        SELECT id, contact_id, content, created_at
        FROM src.contact_memories
      `);
      outputDb.exec(`
        INSERT INTO identities (
          id, platform, platform_id, display_name, username, contact_id,
          skipped, avatar_url, first_seen, last_seen, normalized_name
        )
        SELECT
          id, platform, platform_id, display_name, username, contact_id,
          skipped, avatar_url, first_seen, last_seen, normalized_name
        FROM src.identities
      `);
      outputDb.exec("COMMIT");
      outputDb.exec(`DETACH DATABASE src`);

      contactsCopied = (
        outputDb.prepare(`SELECT COUNT(*) as c FROM contacts`).get() as { c: number }
      ).c;
      memoriesCopied = (
        outputDb.prepare(`SELECT COUNT(*) as c FROM contact_memories`).get() as {
          c: number;
        }
      ).c;
      identitiesCopied = (
        outputDb.prepare(`SELECT COUNT(*) as c FROM identities`).get() as { c: number }
      ).c;
    });

    console.log(
      `Copied ${contactsCopied.toLocaleString()} contacts, ${identitiesCopied.toLocaleString()} identities, ${memoriesCopied.toLocaleString()} memories`
    );
  }

  // Verify
  const outputTotal = (
    outputDb.prepare(`SELECT COUNT(*) as c FROM events`).get() as { c: number }
  ).c;
  const ftsCount = (
    outputDb.prepare(`SELECT COUNT(*) as c FROM events_fts`).get() as {
      c: number;
    }
  ).c;
  const peopleCount = (
    outputDb.prepare(`SELECT COUNT(*) as c FROM event_people`).get() as {
      c: number;
    }
  ).c;
  const outputPairs = outputDb
    .prepare(
      `SELECT source, type, COUNT(*) as count FROM events GROUP BY source, type ORDER BY source, type`
    )
    .all() as { source: string; type: string; count: number }[];

  const identityCount = (
    outputDb.prepare(`SELECT COUNT(*) as c FROM identities`).get() as { c: number }
  ).c;
  const contactCount = (
    outputDb.prepare(`SELECT COUNT(*) as c FROM contacts`).get() as { c: number }
  ).c;
  const memoryCount = (
    outputDb.prepare(`SELECT COUNT(*) as c FROM contact_memories`).get() as {
      c: number;
    }
  ).c;

  console.log(`\nVerification:`);
  console.log(`  Events:       ${outputTotal.toLocaleString()}`);
  console.log(`  FTS entries:  ${ftsCount.toLocaleString()}`);
  console.log(`  People index: ${peopleCount.toLocaleString()}`);
  console.log(`  Identities:   ${identityCount.toLocaleString()}`);
  console.log(`  Contacts:     ${contactCount.toLocaleString()}`);
  console.log(`  Memories:     ${memoryCount.toLocaleString()}`);
  console.log(`  (source,type) pairs: ${outputPairs.length} / ${pairs.length}`);

  if (verbose) {
    console.log(`\nPer-type breakdown:`);
    for (const p of outputPairs) {
      console.log(`  ${p.source} / ${p.type}: ${p.count}`);
    }
  }

  outputDb.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
