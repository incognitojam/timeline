/**
 * Parser CLI Wrapper
 *
 * Reduces boilerplate for parsers that follow the standard CLI pattern:
 *   bun run src/platforms/foo/parser.ts <import-path> [account-name]
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";

/**
 * Validate options before a CLI opens input files, databases, or media.
 * Keep positional arguments and defaults with the caller.
 */
export function parserCliArgs(
  options: {
    usage: string;
    flags?: readonly string[];
    minArgs?: number;
    details?: string;
  },
  args = process.argv.slice(2),
): string[] {
  const { usage, flags = [], minArgs = 0, details } = options;
  for (const arg of args) {
    if (arg.startsWith("-") && arg !== "--help" && arg !== "-h" && !flags.includes(arg)) {
      console.error(`Unknown option: ${arg}. Use --help for usage.`);
      process.exit(1);
    }
  }
  const help = args.includes("--help") || args.includes("-h");
  if (help || args.filter((arg) => !flags.includes(arg)).length < minArgs) {
    console.log(`Usage: ${usage}${flags.map((flag) => ` [${flag}]`).join("")}`);
    console.log("\n  --help, -h  Show usage without importing");
    if (details) console.log(`\n${details}`);
    process.exit(help ? 0 : 1);
  }
  return args;
}

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
  /** Script path under src/, without its extension, for the usage message. */
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
 *   name: "platforms/spotify/parser",
 *   examples: ["bun run src/platforms/spotify/parser.ts ./imports/spotify my-account"],
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

  const args = parserCliArgs({
    usage: `bun run src/${name}.ts ${usage}`,
    minArgs,
    details: examples.length ? `Examples:\n${examples.map((ex) => `  ${ex}`).join("\n")}` : undefined,
  });

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
