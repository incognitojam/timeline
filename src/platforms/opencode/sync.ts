import { getDb, initDb } from "../../db/schema";
import { importOpenCode, resolveOpenCodeStores } from "./parser";
import type { SyncSource, SyncOptions, SyncResult } from "../../sync/types";

export const opencodeSyncSource: SyncSource = {
  name: "opencode",
  description: "Import OpenCode sessions",
  enabled: true,
  configSchema: [
    {
      key: "path",
      type: "string",
      format: "path",
      label: "Data directory",
      description: "OpenCode data directory (usually ~/.local/share/opencode), a legacy storage/ directory, or an opencode.db file",
      required: true,
    },
    {
      key: "account",
      type: "string",
      label: "Account",
      description: "Account name stored with imported sessions",
      required: true,
    },
  ],

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const openCodeDir = config?.path as string | undefined;

    if (!openCodeDir) {
      return "Missing 'path' in opencode sync config";
    }

    try {
      resolveOpenCodeStores(openCodeDir);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["opencode"];
    const openCodeDir = sourceConfig?.path as string | undefined;

    if (!openCodeDir) {
      return {
        source: "opencode",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'path' in opencode sync config",
        durationMs: Date.now() - startTime,
      };
    }

    if (!sourceConfig?.account) {
      return {
        source: "opencode",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'account' in opencode sync config",
        durationMs: Date.now() - startTime,
      };
    }

    const accountName = sourceConfig.account;

    try {
      if (options.verbose) {
        console.log(`[opencode] Importing from ${openCodeDir}`);
        console.log(`[opencode] Account: ${accountName}`);
      }

      const db = getDb();
      initDb(db);

      const stats = await importOpenCode(db, openCodeDir, accountName);
      // Note: importOpenCode already calls onImportComplete internally
      db.close();

      return {
        source: "opencode",
        success: true,
        eventsAdded: stats.messages,
        eventsUpdated: stats.updated,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "opencode",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
