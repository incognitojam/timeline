import { existsSync } from "node:fs";
import { getDb, initDb } from "../../db/schema";
import { importT3Code, DEFAULT_T3CODE_DB } from "../../parsers/t3code";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

function expandPath(configPath: string | undefined): string {
  if (!configPath) return DEFAULT_T3CODE_DB;
  return configPath.startsWith("~")
    ? configPath.replace("~", process.env.HOME || "")
    : configPath;
}

export const t3codeSyncSource: SyncSource = {
  name: "t3code",
  description: "Import T3 Code chat threads",
  enabled: true,
  configSchema: [
    {
      key: "path",
      type: "string",
      format: "path",
      label: "Database path",
      description: "Path to the T3 Code database",
      default: DEFAULT_T3CODE_DB,
    },
    {
      key: "account",
      type: "string",
      label: "Account",
      description: "Account name stored with imported threads",
      required: true,
    },
  ],

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const dbPath = expandPath(config?.path as string | undefined);
    if (!existsSync(dbPath)) {
      return `T3 Code database not found at ${dbPath}`;
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["t3code"];
    const dbPath = expandPath(sourceConfig?.path as string | undefined);

    const accountName = sourceConfig?.account as string | undefined;
    if (!accountName) {
      return {
        source: "t3code",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'account' in t3code sync config",
        durationMs: Date.now() - startTime,
      };
    }

    try {
      if (options.verbose) {
        console.log(`[t3code] Importing from ${dbPath}`);
        console.log(`[t3code] Account: ${accountName}`);
      }

      const db = getDb();
      initDb(db);

      const stats = await importT3Code(db, dbPath, accountName);
      db.close();

      return {
        source: "t3code",
        success: true,
        eventsAdded: stats.messages + stats.toolCalls,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "t3code",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
