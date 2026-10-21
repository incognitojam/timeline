/**
 * Type augmentation to prevent accidental use of db.changes (which doesn't exist in Bun)
 *
 * Bun SQLite does NOT have a `changes` property on Database.
 * You must capture the return value from statement.run() instead:
 *
 * @example
 * // WRONG - will always be undefined
 * stmt.run(...);
 * if (db.changes > 0) { ... }
 *
 * // CORRECT - capture return value
 * const result = stmt.run(...);
 * if (result.changes > 0) { ... }
 */

declare module "bun:sqlite" {
  interface Database {
    /** @deprecated This property does not exist in Bun SQLite. Use statement.run() return value instead. */
    readonly changes: void;
    /** @deprecated This property does not exist in Bun SQLite. */
    readonly totalChanges: void;
  }
}
