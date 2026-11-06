import { existsSync } from "node:fs";
import { getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { getDb } from "../../db/schema";
import { importT3Code, DEFAULT_T3CODE_DB, T3ImportError, type ImportStats } from "./parser";
import type { SyncSource, SyncOptions, SyncResult } from "../../sync/types";

/**
 * A row whose `updated_at` predates the cursor overlap in a thread nothing
 * else changed is invisible to cursor reads; a periodic full read picks it up
 * and writes only what differs.
 */
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface T3CodeSyncState {
  /** v2 read cursor per imported database, keyed by `account|path`. */
  cursors?: Record<string, string>;
  /** When each imported database last had a full read, same keys. */
  reconciledAt?: Record<string, string>;
}

function expandPath(configPath: string | undefined): string {
  if (!configPath) return DEFAULT_T3CODE_DB;
  return configPath.startsWith("~")
    ? configPath.replace("~", process.env.HOME || "")
    : configPath;
}

function eventsAdded(stats: ImportStats): number {
  return stats.messages + stats.toolCalls + stats.plans + stats.reasoning;
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
      description:
        "Path to the T3 Code database: statev2.sqlite for current T3 Code and styal (e.g. ~/.styal/userdata/statev2.sqlite), state.sqlite for older T3 Code",
      default: DEFAULT_T3CODE_DB,
    },
    {
      key: "account",
      type: "string",
      label: "Account",
      description:
        "Account name stored with imported threads: one per machine, matching that machine's Claude Code/Codex/OpenCode account so its threads replace their transcripts in conversation lists",
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

      const appDb = getAppStateDb();
      const state = getSyncState<T3CodeSyncState>(appDb, "t3code") ?? {};
      const cursorKey = `${accountName}|${dbPath}`;
      const reconciledAt = state.reconciledAt?.[cursorKey];
      const reconcile = !reconciledAt || startTime - Date.parse(reconciledAt) >= RECONCILE_INTERVAL_MS;

      // No initDb here: its immediate transaction would take the write lock on
      // every sync, and the service and sync:once have already run it.
      const db = getDb();
      let stats: Awaited<ReturnType<typeof importT3Code>>;
      try {
        stats = await importT3Code(db, dbPath, accountName, {
          cursor: reconcile ? null : (state.cursors?.[cursorKey] ?? null),
        });
      } finally {
        db.close();
      }

      if (stats.cursor) {
        setSyncState(appDb, "t3code", {
          ...state,
          cursors: { ...state.cursors, [cursorKey]: stats.cursor },
          reconciledAt: reconcile
            ? { ...state.reconciledAt, [cursorKey]: new Date(startTime).toISOString() }
            : state.reconciledAt,
        } satisfies T3CodeSyncState);
      }

      return {
        source: "t3code",
        success: true,
        eventsAdded: eventsAdded(stats),
        eventsUpdated: stats.refreshed,
        durationMs: Date.now() - startTime,
        metadata: {
          store: stats.store,
          threads: stats.threads.size,
          pendingTranscriptThreads: stats.pendingTranscriptThreads,
          writeTransactions: stats.writeTransactions,
          longestWriteHoldMs: stats.longestWriteHoldMs,
        },
      };
    } catch (error) {
      return {
        source: "t3code",
        success: false,
        // A failed run keeps what it committed; the retry won't count it again.
        eventsAdded: error instanceof T3ImportError ? eventsAdded(error.stats) : 0,
        eventsUpdated: error instanceof T3ImportError ? error.stats.refreshed : 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
