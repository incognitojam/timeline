/**
 * ThumbHash LQIP (Low-Quality Image Placeholder) Utility
 *
 * Generates compact ThumbHash placeholders for image attachments.
 * Uses sharp to resize images to max 100x100 and extract raw RGBA pixels,
 * then encodes with thumbhash for ~30 byte placeholders that can be
 * decoded to blurred data URLs on the frontend.
 */

import { Database } from "bun:sqlite";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";
import { getMediaStore } from "./storage";

export interface ProcessingStats {
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface ProcessingOptions {
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
}

// The queue is normally tiny compared with all stored attachments. Without
// planner statistics SQLite prefers idx_attachments_status, so pin this query
// to the partial index that contains only rows needing thumbhash work.
export const THUMBHASH_QUEUE_SQL = `
  SELECT id, storage_path, mime_type
  FROM attachments INDEXED BY idx_attachments_needs_thumbhash
  WHERE status = 'stored'
    AND storage_path IS NOT NULL
    AND mime_type LIKE 'image/%'
    AND thumbhash IS NULL
`;

/**
 * Generate a ThumbHash from an image file path or buffer.
 * Returns a base64-encoded ThumbHash string.
 */
export async function generateThumbHash(input: Buffer | string): Promise<string> {
  const image = typeof input === "string" ? sharp(input) : sharp(input);

  // Resize to max 100x100 preserving aspect ratio, extract raw RGBA
  const { data, info } = await image
    .resize(100, 100, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const hash = rgbaToThumbHash(info.width, info.height, data);
  return Buffer.from(hash).toString("base64");
}

/**
 * Process attachments that need thumbhashes.
 * Queries the partial index for stored images without a thumbhash,
 * reads files from disk, generates thumbhashes, and updates the DB.
 */
export async function processAttachmentThumbhashes(
  db: Database,
  options: ProcessingOptions = {}
): Promise<ProcessingStats> {
  const { limit, concurrency = 8, dryRun = false, signal } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error(`limit must be a non-negative integer, got ${limit}`);
  }

  const stats: ProcessingStats = {
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  if (limit === 0) return stats;

  const mediaStore = await getMediaStore();
  const query = db.prepare(`${THUMBHASH_QUEUE_SQL} ${limit !== undefined ? `LIMIT ${limit}` : ""}`);

  const updateThumbhash = db.prepare(`
    UPDATE attachments SET thumbhash = ? WHERE id = ?
  `);

  const attachments = query.all() as { id: number; storage_path: string; mime_type: string }[];

  async function processOne(attachment: { id: number; storage_path: string; mime_type: string }): Promise<"updated" | "skipped" | "error"> {
    const filePath = mediaStore.getAbsolutePath(attachment.storage_path);

    try {
      const hash = await generateThumbHash(filePath);
      if (!dryRun) {
        updateThumbhash.run(hash, attachment.id);
      }
      return "updated";
    } catch {
      // Mark permanent failures with a sentinel so they're excluded from
      // future runs (thumbhash IS NULL won't match them anymore)
      if (!dryRun) {
        updateThumbhash.run("error", attachment.id);
      }
      return "error";
    }
  }

  // Process in batches with concurrency, respecting abort signal
  for (let i = 0; i < attachments.length; i += concurrency) {
    if (signal?.aborted) break;

    const batch = attachments.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(processOne));

    for (const result of results) {
      stats.processed++;
      if (result === "updated") stats.updated++;
      else if (result === "skipped") stats.skipped++;
      else stats.errors++;
    }
  }

  return stats;
}
