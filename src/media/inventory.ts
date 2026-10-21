/**
 * Read-only media inventory/audit.
 *
 * Walks every table in the {@link MEDIA_TABLES} registry, dedupes by
 * `content_hash`, and classifies each unique blob by local-presence × remote-
 * presence. It writes and deletes nothing — it just sizes the work the later
 * rungs will do: the existing-cache upload (local-only blobs) and the recovery
 * backfills (blobs missing locally and remotely).
 */

import type { Database } from "bun:sqlite";
import { extname } from "path";
import type { RemoteBlobStore } from "./storage";
import { MEDIA_TABLES, type MediaTable } from "./registry";

/** Just the slice of a media store the inventory needs (local presence). */
export interface LocalPresence {
  hasHash(hash: string, ext: string): Promise<boolean>;
}

export interface InventoryBucket {
  blobs: number;
  bytes: number;
}

export interface MediaInventory {
  tables: string[];
  /** Unique content hashes across all media tables (deduped). */
  uniqueBlobs: number;
  /** Whether remote membership was checked (false when R2 is not configured). */
  r2Checked: boolean;
  /** Present in R2 (durable), whether or not also cached locally. */
  durableInR2: InventoryBucket;
  /** Local file present, not in R2 — the existing-cache upload set. */
  localOnly: InventoryBucket;
  /** No local file and not in R2 — the recovery set. */
  missing: InventoryBucket;
  /** Rows in a `failed` state (e.g. attachments that never downloaded). */
  failedRows: number;
}

export interface BlobMeta {
  /** All extensions this content appears under (dedup is per hash+ext). */
  exts: Set<string>;
  size: number;
}

/**
 * Enumerate unique content-addressed blobs across the media registry, recording
 * every extension a hash appears under (dedup is per hash+ext) plus its size,
 * and counting rows in a `failed` state. Table/column names come from the
 * trusted registry constant, never user input. Shared by the inventory and the
 * existing-cache upload so they agree on the blob set.
 */
export function collectMediaBlobs(
  db: Database,
  tables: readonly MediaTable[] = MEDIA_TABLES,
): { blobs: Map<string, BlobMeta>; failedRows: number } {
  const blobs = new Map<string, BlobMeta>();
  let failedRows = 0;

  for (const t of tables) {
    const rows = db
      .query(
        `SELECT ${t.hashCol} AS hash, ${t.pathCol} AS path, ${t.sizeCol} AS size
         FROM ${t.table}
         WHERE status = 'stored' AND ${t.hashCol} IS NOT NULL AND ${t.pathCol} IS NOT NULL`,
      )
      .all() as { hash: string; path: string; size: number | null }[];
    for (const r of rows) {
      const ext = extname(r.path);
      const existing = blobs.get(r.hash);
      if (existing) {
        existing.exts.add(ext);
      } else {
        blobs.set(r.hash, { exts: new Set([ext]), size: r.size ?? 0 });
      }
    }

    const failed = db
      .query(`SELECT COUNT(*) AS n FROM ${t.table} WHERE status = 'failed'`)
      .get() as { n: number };
    failedRows += failed.n;
  }

  return { blobs, failedRows };
}

export async function inventoryMedia(
  db: Database,
  local: LocalPresence,
  remote: RemoteBlobStore | null,
  tables: readonly MediaTable[] = MEDIA_TABLES,
): Promise<MediaInventory> {
  const { blobs, failedRows } = collectMediaBlobs(db, tables);

  // Local presence: the by-hash blob is keyed by hash+ext, and the same content
  // can appear under more than one extension — so it's local if ANY of its
  // extensions exists on disk.
  const localPresent = new Set<string>();
  for (const [hash, meta] of blobs) {
    for (const ext of meta.exts) {
      if (await local.hasHash(hash, ext)) {
        localPresent.add(hash);
        break;
      }
    }
  }

  // Remote presence: one bulk membership scan (null when R2 not configured).
  const r2Present = remote ? await remote.presentHashes(blobs.keys()) : null;

  const durableInR2: InventoryBucket = { blobs: 0, bytes: 0 };
  const localOnly: InventoryBucket = { blobs: 0, bytes: 0 };
  const missing: InventoryBucket = { blobs: 0, bytes: 0 };

  for (const [hash, meta] of blobs) {
    const inR2 = r2Present?.has(hash) ?? false;
    const bucket = inR2 ? durableInR2 : localPresent.has(hash) ? localOnly : missing;
    bucket.blobs++;
    bucket.bytes += meta.size;
  }

  return {
    tables: tables.map((t) => t.table),
    uniqueBlobs: blobs.size,
    r2Checked: r2Present !== null,
    durableInR2,
    localOnly,
    missing,
    failedRows,
  };
}
