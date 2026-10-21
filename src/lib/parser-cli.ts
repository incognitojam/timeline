/**
 * Parser CLI Wrapper
 *
 * Reduces boilerplate for parsers that follow the standard CLI pattern:
 *   bun run src/parsers/foo.ts <import-path> [account-name]
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";

/**
 * Standard parser function signature.
 * Takes a database, import path, and account name.
 */
export type ParserFn = (
  db: Database,
  importPath: string,
  accountName: string
) => Promise<void | number>;

/**
 * Options for the parser CLI wrapper
 */
export interface ParserCliOptions {
  /** Parser name used in usage message (e.g., "spotify") */
  name: string;
  /** Argument description (default: "<import-path> [account-name]") */
  usage?: string;
  /** Example commands to show in usage */
  examples?: string[];
  /** Default account name (default: "default") */
  defaultAccount?: string;
  /** Minimum required arguments (default: 1) */
  minArgs?: number;
}

/**
 * Wraps a parser function with standard CLI handling.
 *
 * Handles:
 * - Argument parsing
 * - Usage/help display
 * - Database initialization
 * - Error handling
 * - Database cleanup
 *
 * @example
 * ```typescript
 * // At the end of spotify.ts:
 * runParser(importSpotifyData, {
 *   name: "spotify",
 *   examples: ["bun run src/parsers/spotify.ts ./imports/spotify my-account"],
 * });
 * ```
 */
export function runParser(fn: ParserFn, options: ParserCliOptions): void {
  const {
    name,
    usage = "<import-path> [account-name]",
    examples = [],
    defaultAccount = "default",
    minArgs = 1,
  } = options;

  const args = process.argv.slice(2);

  if (args.length < minArgs) {
    console.log(`Usage: bun run src/parsers/${name}.ts ${usage}`);
    if (examples.length > 0) {
      console.log("\nExamples:");
      for (const ex of examples) {
        console.log(`  ${ex}`);
      }
    }
    process.exit(1);
  }

  const importPath = args[0];
  const accountName = args[1] || defaultAccount;

  const db = getDb();
  initDb(db);

  fn(db, importPath, accountName)
    .then(() => {
      db.close();
    })
    .catch((err) => {
      console.error("Import failed:", err);
      db.close();
      process.exit(1);
    });
}
