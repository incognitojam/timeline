import { existsSync } from "node:fs";
import { getDb, initDb } from "../../db/schema";
import { importClaudeCode } from "../../parsers/claude-code";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

export const claudeCodeSyncSource: SyncSource = {
  name: "claude-code",
  description: "Import Claude Code sessions",
  enabled: true,
  configSchema: [
    {
      key: "path",
      type: "string",
      format: "path",
      label: "Sessions directory",
      description: "Directory containing Claude Code sessions",
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
    const claudeDir = config?.path as string | undefined;

    if (!claudeDir) {
      return "Missing 'path' in claude-code sync config";
    }

    if (!existsSync(claudeDir)) {
      return `Claude Code directory not found at ${claudeDir}`;
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["claude-code"];
    const claudeDir = sourceConfig?.path as string | undefined;

    if (!claudeDir) {
      return {
        source: "claude-code",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'path' in claude-code sync config",
        durationMs: Date.now() - startTime,
      };
    }

    if (!sourceConfig?.account) {
      return {
        source: "claude-code",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'account' in claude-code sync config",
        durationMs: Date.now() - startTime,
      };
    }

    const accountName = sourceConfig.account;

    try {
      if (options.verbose) {
        console.log(`[claude-code] Importing from ${claudeDir}`);
        console.log(`[claude-code] Account: ${accountName}`);
      }

      const db = getDb();
      initDb(db);

      const stats = await importClaudeCode(db, claudeDir, accountName);
      // Note: importClaudeCode already calls onImportComplete internally
      db.close();

      return {
        source: "claude-code",
        success: true,
        eventsAdded: stats.messages,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "claude-code",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
