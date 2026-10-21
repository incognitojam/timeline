import { existsSync } from "node:fs";
import { getDb, initDb } from "../../db/schema";
import { importCodex, DEFAULT_CODEX_SESSIONS_DIR } from "../../parsers/codex";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

function expandPath(configPath: string | undefined): string {
  if (!configPath) return DEFAULT_CODEX_SESSIONS_DIR;
  return configPath.startsWith("~")
    ? configPath.replace("~", process.env.HOME || "")
    : configPath;
}

export const codexSyncSource: SyncSource = {
  name: "codex",
  description: "Import Codex CLI sessions",
  enabled: true,
  configSchema: [
    {
      key: "path",
      type: "string",
      format: "path",
      label: "Sessions directory",
      description: "Directory containing Codex sessions",
      default: DEFAULT_CODEX_SESSIONS_DIR,
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
    const sessionsDir = expandPath(config?.path as string | undefined);
    if (!existsSync(sessionsDir)) {
      return `Codex sessions directory not found at ${sessionsDir}`;
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["codex"];
    const sessionsDir = expandPath(sourceConfig?.path as string | undefined);

    const accountName = sourceConfig?.account as string | undefined;
    if (!accountName) {
      return {
        source: "codex",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'account' in codex sync config",
        durationMs: Date.now() - startTime,
      };
    }

    try {
      if (options.verbose) {
        console.log(`[codex] Importing from ${sessionsDir}`);
        console.log(`[codex] Account: ${accountName}`);
      }

      const db = getDb();
      initDb(db);

      const stats = await importCodex(db, sessionsDir, accountName);
      db.close();

      return {
        source: "codex",
        success: true,
        eventsAdded: stats.messages + stats.toolCalls + stats.reasoning,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "codex",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
