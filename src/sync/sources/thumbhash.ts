/**
 * ThumbHash Sync Source
 *
 * Generates ThumbHash LQIP placeholders for stored image attachments.
 * Runs on a short interval to process newly stored images automatically.
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../../db/schema";
import { processAttachmentThumbhashes } from "../../media/thumbhash";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

/**
 * Count images that still need thumbhash processing.
 * Uses the idx_attachments_needs_thumbhash partial index.
 */
function countNeedingThumbhash(db: Database): number {
  const result = db
    .prepare(
      `SELECT COUNT(*) as count FROM attachments
       WHERE status = 'stored' AND storage_path IS NOT NULL AND mime_type LIKE 'image/%' AND thumbhash IS NULL`
    )
    .get() as { count: number };
  return result.count;
}

export const thumbhashSyncSource: SyncSource = {
  name: "thumbhash",
  description: "Generate ThumbHash LQIP placeholders for images",
  enabled: true,

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    // Validate that the DB is accessible and the attachments table exists.
    // Don't check queue emptiness here — an empty queue is a successful no-op,
    // not a reason to report failure.
    const db = getDb();
    try {
      initDb(db);
      return null;
    } finally {
      db.close();
    }
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();

    const db = getDb();
    try {
      initDb(db);

      const stats = await processAttachmentThumbhashes(db, {
        concurrency: 8,
        signal: options.signal,
      });

      return {
        source: "thumbhash",
        success: true,
        eventsAdded: 0,
        eventsUpdated: stats.updated,
        durationMs: Date.now() - startTime,
        metadata: {
          processed: stats.processed,
          updated: stats.updated,
          skipped: stats.skipped,
          errors: stats.errors,
        },
      };
    } catch (err) {
      return {
        source: "thumbhash",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    } finally {
      db.close();
    }
  },
};
