/**
 * Compare a database's event types and source ids with what platforms declare.
 *
 * Prints source ids, type names and counts only, never event content, so the
 * output is safe to read for a personal database. Never writes to the databases.
 *
 * Usage: bun run check-event-types [db-path]   (default: ./timeline.db)
 * Exits 1 if anything is undeclared or unregistered.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { undeclaredEventPairs, unusedDeclarations } from "../platforms/event-types";
import { isRegisteredSource } from "../shared/sources";

const dbPath = process.argv[2] ?? "./timeline.db";
if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

/**
 * A `-wal` file may hold committed frames, and only a read-only connection reads
 * them without checkpointing into the database on close. Without one there is
 * nothing to checkpoint, and macOS's SQLite can't open such a database read-only
 * (a prepare-full clone, for example), so use `query_only` there.
 */
function openWithoutWriting(path: string): Database {
  if (existsSync(`${path}-wal`)) return new Database(path, { readonly: true });
  const opened = new Database(path);
  opened.run("PRAGMA query_only = ON");
  return opened;
}

const db = openWithoutWriting(dbPath);

function distinct(from: Database, column: string, table: string): string[] {
  return from.query<{ value: string }, []>(`SELECT DISTINCT ${column} AS value FROM ${table}`).all().map((row) => row.value);
}

const seenIds: [string, string[]][] = [
  ["events.source", distinct(db, "source", "events")],
  ["identities.platform", distinct(db, "platform", "identities")],
];
const appStatePath = join(dirname(dbPath), "app-state.db");
if (existsSync(appStatePath)) {
  const appState = openWithoutWriting(appStatePath);
  seenIds.push(["sync_log.source", distinct(appState, "source", "sync_log")]);
  seenIds.push(["sync_sources.source", distinct(appState, "source", "sync_sources")]);
  appState.close();
} else {
  console.log(`No app-state.db beside ${dbPath}: sync_log and sync_sources not checked.`);
}

const undeclared = undeclaredEventPairs(db);
console.log(`Undeclared event types: ${undeclared.length}`);
for (const { source, type, count } of undeclared) console.log(`  ${source} ${type} (${count})`);

let unregisteredCount = 0;
for (const [column, ids] of seenIds) {
  const unregistered = ids.filter((id) => !isRegisteredSource(id)).sort();
  unregisteredCount += unregistered.length;
  console.log(`Unregistered ids in ${column}: ${unregistered.length}${unregistered.length > 0 ? ` (${unregistered.join(", ")})` : ""}`);
}

const unused = unusedDeclarations(db);
console.log(`Declared types with no rows (information only): ${unused.length}`);
for (const { source, type, legacy } of unused) console.log(`  ${source} ${type}${legacy ? " (legacy)" : ""}`);

db.close();
process.exit(undeclared.length > 0 || unregisteredCount > 0 ? 1 : 0);
