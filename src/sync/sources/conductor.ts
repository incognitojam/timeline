import { existsSync } from "node:fs";
import { getDb, initDb } from "../../db/schema";
import {
  importConductor,
  detectAccountFromRepos,
  DEFAULT_CONDUCTOR_DB,
} from "../../parsers/conductor";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

export const conductorSyncSource: SyncSource = {
  name: "conductor",
  description: "Import Conductor chat sessions",
  enabled: true,
  configSchema: [
    {
      key: "path",
      type: "string",
      format: "path",
      label: "Database path",
      description: "Path to the Conductor database",
      default: DEFAULT_CONDUCTOR_DB,
    },
    {
      key: "account",
      type: "string",
      label: "Account",
      description: "Account name stored with imported sessions",
    },
  ],

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const configPath = config?.path as string | undefined;
    const dbPath = configPath
      ? (configPath.startsWith("~")
          ? configPath.replace("~", process.env.HOME || "")
          : configPath)
      : DEFAULT_CONDUCTOR_DB;
    if (!existsSync(dbPath)) {
      return `Conductor database not found at ${dbPath}`;
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["conductor"];
    const configPath = sourceConfig?.path as string | undefined;

    const expandedPath = configPath
      ? (configPath.startsWith("~")
          ? configPath.replace("~", process.env.HOME || "")
          : configPath)
      : DEFAULT_CONDUCTOR_DB;

    // Get account from config or auto-detect from branch prefixes
    let accountName = sourceConfig?.account as string | undefined;
    if (!accountName) {
      accountName = detectAccountFromRepos(expandedPath) || undefined;
    }

    if (!accountName) {
      return {
        source: "conductor",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Could not determine account - set 'account' in conductor sync config",
        durationMs: Date.now() - startTime,
      };
    }

    try {
      if (options.verbose) {
        console.log(`[conductor] Importing from ${expandedPath}`);
        console.log(`[conductor] Account: ${accountName}`);
      }

      const db = getDb();
      initDb(db);

      const stats = await importConductor(db, expandedPath, accountName);
      db.close();

      return {
        source: "conductor",
        success: true,
        eventsAdded: stats.messages,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "conductor",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
