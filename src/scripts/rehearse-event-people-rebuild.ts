#!/usr/bin/env bun
/**
 * Rehearse the event_people rebuild on a copy of a Timeline database, as the
 * macOS host guide describes: verify, install this checkout's schema as the
 * service would, rebuild, verify again and truncate the WAL. Prints one JSON
 * line per step (counts, sizes and timings only), then pass or fail against
 * the criteria below, and exits non-zero on a failure.
 *
 * Usage: TIMELINE_DB_PATH=<copy.db> bun run src/scripts/rehearse-event-people-rebuild.ts <copy.db>
 *
 * TIMELINE_DB_PATH only moves the schema module's import-time check for a
 * .no-local-db marker off the checkout; the script opens nothing but the copy,
 * and finds the live database the way the service does (getServiceDbPath).
 */

import { existsSync, lstatSync, statSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { applyConnectionPragmas } from "../db/connection";
import { hiddenEventIdsSubquery } from "../db/events";
import { getServiceDbPath } from "../db/paths";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { configureBunSqliteForSqliteVec } from "../embeddings/sqlite-vec";
import { assertNotHostDataDir } from "../seed/install";
import {
  issueCount,
  isClean,
  rebuildAndVerify,
  sqliteDescription,
  type VerificationResult,
  verifyEventPeople,
} from "./verify-event-people";

/** Free space the host guide requires before a rebuild. */
export const FREE_SPACE_FLOOR_BYTES = 5e9;
/** Room left for the index sorts' temporary files, which the rehearsal can't see. */
const TEMP_FILES_ALLOWANCE_BYTES = 1e9;
/** WAL per new row the floor assumes, plus a fixed allowance for small tables. */
const WAL_BYTES_PER_ROW = 400;
const WAL_FIXED_BYTES = 16e6;

const SIDECARS = ["", "-wal", "-shm"];

/**
 * Refuse anything but a separate copy: a path in the host database's directory,
 * a symlinked -wal or -shm, or a database, -wal or -shm that is the same file
 * (by device and inode, through symlinks) as one of the host database's.
 */
export function assertRehearsalCopy(path: string, hostDbPath: string): void {
  if (!existsSync(path)) throw new Error(`No database at ${path}`);
  assertNotHostDataDir(dirname(path), hostDbPath);
  for (const suffix of SIDECARS.slice(1)) {
    const sidecar = `${path}${suffix}`;
    let link = false;
    try {
      link = lstatSync(sidecar).isSymbolicLink();
    } catch {
      // No sidecar.
    }
    if (link) throw new Error(`Refusing to rehearse on ${path}: ${sidecar} is a symlink`);
  }
  const files = (base: string) =>
    SIDECARS.map((suffix) => `${base}${suffix}`).filter(existsSync).map((file) => statSync(file));
  const host = files(hostDbPath);
  for (const copy of files(path)) {
    if (host.some((file) => file.dev === copy.dev && file.ino === copy.ino)) {
      throw new Error(`Refusing to rehearse on ${path}: it shares a file with the Timeline host database (${hostDbPath})`);
    }
  }
}

export interface Criterion {
  name: string;
  passed: boolean;
  detail: string;
}

interface RehearsalOptions {
  print: (line: string) => void;
  verify?: (db: Database) => VerificationResult;
}

/** Rehearse on `path` and return the criteria; stops before rebuilding if the copy has drift. */
export function rehearse(path: string, { print, verify = verifyEventPeople }: RehearsalOptions): Criterion[] {
  const size = (file: string) => (existsSync(file) ? statSync(file).size : 0);
  const free = () => {
    const stats = statfsSync(dirname(path));
    return stats.bavail * stats.bsize;
  };
  const files = () => ({ databaseBytes: size(path), walBytes: size(`${path}-wal`), freeBytes: free() });
  const timed = <T>(run: () => T): [T, number] => {
    const start = performance.now();
    const value = run();
    return [value, Math.round((performance.now() - start) / 100) / 10];
  };
  const step = (name: string, details: object) => print(JSON.stringify({ step: name, ...details }));
  const criteria: Criterion[] = [];
  const check = (name: string, passed: boolean, detail: string) => criteria.push({ name, passed, detail });

  const db = new Database(path);
  try {
    applyConnectionPragmas(db);
    const all = <T>(sql: string) => db.prepare(sql).all() as T[];
    const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;
    const events = count("SELECT COUNT(*) AS count FROM events");
    step("copy", {
      sqlite: sqliteDescription(db),
      events,
      eventsWithNonArrayPeople: count(
        "SELECT COUNT(*) AS count FROM events WHERE people IS NOT NULL AND CASE WHEN json_valid(people) THEN json_type(people) != 'array' ELSE 1 END",
      ),
      ...files(),
    });

    check("The copy has events", events > 0, `${events} events`);
    if (events === 0) return criteria;

    const [before, verifyBeforeSeconds] = timed(() => verify(db));
    step("verify before", { seconds: verifyBeforeSeconds, ...before });
    check("No drift before the rebuild", issueCount(before) === 0, `${issueCount(before)} discrepancies`);
    if (issueCount(before) > 0) return criteria;
    check("The copy has member rows from before the rule to drop", before.rowsBeforeSenderRule > 0,
      `${before.rowsBeforeSenderRule} rows; with none, the rebuild changes nothing and the rehearsal shows nothing`);

    const [, initSeconds] = timed(() => initDb(db));
    step("install this build's schema and triggers", { seconds: initSeconds, ...files() });

    const snapshot = () => ({
      rows: count("SELECT COUNT(*) AS count FROM event_people"),
      rowsBySource: all<{ source: string; rows: number }>("SELECT source, COUNT(*) AS rows FROM event_people GROUP BY source ORDER BY rows DESC"),
      hiddenBySource: all<{ source: string; events: number }>(
        `SELECT e.source, COUNT(*) AS events FROM events e WHERE e.id IN (${hiddenEventIdsSubquery()}) GROUP BY e.source ORDER BY events DESC`,
      ),
      identities: new Set(all<{ id: number }>("SELECT id FROM identities WHERE event_count > 0").map((row) => row.id)),
    });
    const old = snapshot();
    step("before", { rows: old.rows, rowsBySource: old.rowsBySource, identitiesWithEvents: old.identities.size });

    const freeBefore = free();
    const [outcome, rebuildSeconds] = timed(() => rebuildAndVerify(db, verify));
    // The WAL only grows until a checkpoint, so its size now is the rebuild's peak.
    const walPeak = size(`${path}-wal`);
    step("rebuild", { seconds: rebuildSeconds, outcome: outcome.kind, rows: "rows" in outcome ? outcome.rows : undefined, freeBytesBefore: freeBefore, walPeakBytes: walPeak, ...files() });
    check("Rebuild committed", outcome.kind !== "rolled-back", outcome.kind === "rolled-back" ? String(outcome.error) : "committed");
    if (outcome.kind === "rolled-back") return criteria;
    check("Verified clean after the rebuild", outcome.kind === "committed" && isClean(outcome.after),
      outcome.kind === "committed" ? JSON.stringify(outcome.after) : `verification failed: ${String(outcome.error)}`);
    if (outcome.kind === "committed") step("verify after", outcome.after);

    check("WAL per new row within the estimate", walPeak <= outcome.rows * WAL_BYTES_PER_ROW + WAL_FIXED_BYTES,
      `${walPeak} bytes for ${outcome.rows} rows (estimate ${WAL_BYTES_PER_ROW} bytes per row)`);
    const rowsTheFloorCovers = Math.floor((FREE_SPACE_FLOOR_BYTES - TEMP_FILES_ALLOWANCE_BYTES) / WAL_BYTES_PER_ROW);
    check("New rows within what the free-space floor covers", outcome.rows <= rowsTheFloorCovers,
      `${outcome.rows} rows; the floor covers ${rowsTheFloorCovers} at ${WAL_BYTES_PER_ROW} bytes each`);
    check("Peak WAL and temp files within the free-space floor", walPeak + TEMP_FILES_ALLOWANCE_BYTES <= FREE_SPACE_FLOOR_BYTES,
      `${walPeak} WAL + ${TEMP_FILES_ALLOWANCE_BYTES} temp allowance against a floor of ${FREE_SPACE_FLOOR_BYTES}`);

    const now = snapshot();
    const hiddenNow = new Map(now.hiddenBySource.map((row) => [row.source, row.events]));
    step("after", {
      rows: now.rows,
      rowsBySource: now.rowsBySource,
      identitiesWithEvents: now.identities.size,
      identitiesNowWithoutEvents: [...old.identities].filter((id) => !now.identities.has(id)).length,
      eventsNoLongerHiddenBySource: old.hiddenBySource.map((row) => ({ source: row.source, events: row.events - (hiddenNow.get(row.source) ?? 0) })),
    });

    const [, checkpointSeconds] = timed(() => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"));
    step("checkpoint", { seconds: checkpointSeconds, ...files() });
    return criteria;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: TIMELINE_DB_PATH=<copy.db> bun run src/scripts/rehearse-event-people-rebuild.ts <copy.db>");
    process.exit(1);
  }
  assertRehearsalCopy(path, getServiceDbPath());
  // Use the SQLite library the service uses, chosen before any database opens.
  configureBunSqliteForSqliteVec();
  const criteria = rehearse(path, { print: console.log });
  const passed = criteria.every((criterion) => criterion.passed);
  console.log("\nSummary");
  for (const criterion of criteria) console.log(`  ${criterion.passed ? "PASS" : "FAIL"}  ${criterion.name}: ${criterion.detail}`);
  console.log("  DECIDE  eventsNoLongerHiddenBySource and identitiesNowWithoutEvents in the after step.");
  console.log(passed ? "\nREHEARSAL PASSED" : "\nREHEARSAL FAILED: do not run the rebuild on the host.");
  process.exit(passed ? 0 : 1);
}
