import { Database } from "bun:sqlite";
import { assertNoLocalDbMarker, getDbPathInfo } from "./paths";

/**
 * Settings every writable connection needs, as opposed to the schema itself.
 * journal_mode = WAL persists in the database file once set; the others are
 * per connection.
 *
 * recursive_triggers matters for correctness, not just performance: REPLACE
 * resolves uniqueness conflicts through an implicit DELETE + INSERT, and SQLite
 * only fires DELETE triggers for that path when it is on — which derived tables
 * and FTS need to balance the removed row. Every connection that writes must set
 * it, so both getDb() and initDb() (whose callers open their own connections) do.
 */
export function applyConnectionPragmas(db: Database): void {
  // Set first: switching to WAL needs a lock another connection may hold.
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA recursive_triggers = ON");
}

/** Open a timeline database read/write without loading the schema module. */
export function openWritableDbAtPath(dbPath: string): Database {
  const info = getDbPathInfo(dbPath);
  assertNoLocalDbMarker(info, info.resolvedDbPath, "database");
  const db = new Database(dbPath);
  applyConnectionPragmas(db);
  return db;
}
