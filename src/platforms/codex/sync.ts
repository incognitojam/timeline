import { existsSync } from "node:fs";
import { getDb } from "../../db/schema";
import { importCodex, CodexImportError, DEFAULT_CODEX_SESSIONS_DIR } from "./parser";
import type { SyncSource, SyncOptions, SyncResult } from "../../sync/types";

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
      let stats;
      try {
        stats = await importCodex(db, sessionsDir, accountName);
      } finally {
        db.close();
      }

      return {
        source: "codex",
        success: true,
        eventsAdded: stats.messages + stats.toolCalls + stats.reasoning,
        eventsUpdated: stats.refreshed,
        metadata: { filesSkipped: stats.filesSkipped, writeTransactions: stats.writeTransactions, longestWriteHoldMs: stats.longestWriteHoldMs },
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "codex",
        success: false,
        eventsAdded: error instanceof CodexImportError ? error.stats.messages + error.stats.toolCalls + error.stats.reasoning : 0,
        eventsUpdated: error instanceof CodexImportError ? error.stats.refreshed : 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
