import { existsSync } from "node:fs";
import { getDb, initDb } from "../../db/schema";
import { importRecall } from "../../parsers/recall";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

const RECALL_SYNC_BATCH_SIZE = 1_000;

export const recallSyncSource: SyncSource = {
  name: "recall",
  description: "Import MacBook screen captures from the recall inbox",
  enabled: true,
  configSchema: [
    {
      key: "path",
      type: "string",
      format: "path",
      label: "Recall directory",
      description: "Directory containing screen captures to import",
    },
  ],

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const path = config?.path as string | undefined;
    if (!path) {
      return "Missing 'path' in recall sync config";
    }
    if (!existsSync(path)) {
      return `Recall directory not found at ${path}`;
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources.recall;
    const path = sourceConfig?.path as string | undefined;

    if (!path) {
      return {
        source: "recall",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'path' in recall sync config",
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const db = getDb();
      initDb(db);
      const stats = await importRecall(db, path, { maxCaptures: RECALL_SYNC_BATCH_SIZE });
      db.close();

      return {
        source: "recall",
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
        metadata: {
          scanned: stats.scanned,
          deduplicated: stats.deduplicated,
          skipped: stats.skipped,
          failed: stats.failed,
        },
      };
    } catch (error) {
      return {
        source: "recall",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
