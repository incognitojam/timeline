import type { Database } from "bun:sqlite";

/**
 * Writes test fixtures in one transaction. Outside a transaction every
 * statement on a file-backed database commits separately and waits for an
 * fsync, which on some filesystems (ZFS) costs milliseconds per row and blocks
 * the test process's event loop, starving servers and timers in concurrent
 * tests. Use it for any fixture that writes more than a handful of rows.
 */
export function seed<T>(db: Database, write: () => T): T {
  return db.transaction(write).immediate();
}
