/**
 * Local media cache eviction — planner and executor.
 *
 * `planEviction` (read-only) measures the cache's disk usage and, against a
 * configured bound, computes which blobs eviction *would* drop — the oldest by
 * cache mtime among blobs confirmed durable in R2. `evictMedia` runs that plan
 * and, unless dry-run, deletes the selected blobs' local hardlinks; R2 keeps the
 * durable copy and read-through restores them on demand. The planner also serves
 * as the basis for a `/status` cache metric.
 *
 * Why mtime: write-through and restore-on-read both rewrite the by-hash file, so
 * its mtime tracks when the blob was last brought into the cache. Evicting
 * oldest-mtime therefore keeps recently-cached (hot) blobs and ages out cold
 * ones, and the restore-on-read loop re-caches anything that gets accessed again
 * — a self-correcting LRU-ish cache without any access-tracking table.
 */

import type { Database } from "bun:sqlite";
import type { MediaConfig } from "../config";
import type { RemoteBlobStore } from "./storage";
import { collectMediaBlobs } from "./inventory";
import { MEDIA_TABLES, type MediaTable } from "./registry";

const GIB = 1024 ** 3;
export const DEFAULT_TARGETED_EVICTION_HEAD_CHECK_LIMIT = 128;

/**
 * Resolve `[media].cache_limit_gib` to a byte bound (null when unset), validating
 * it is a non-negative number. Shared by the CLI and the scheduled eviction job.
 */
export function cacheLimitBytes(media: MediaConfig): number | null {
  const raw = media.cache_limit_gib;
  if (raw === undefined) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new Error(`[media].cache_limit_gib must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return raw * GIB;
}

/** The slice of a local store the planner reads through. */
export interface LocalStat {
  statByHash(hash: string, ext: string): Promise<{ size: number; mtimeMs: number } | null>;
}

/** The local store the executor also deletes through. */
export interface LocalEvictor extends LocalStat {
  removeBlob(hash: string, exts: string[], storagePaths: string[]): Promise<void>;
}

/**
 * A blob the plan would evict. To actually reclaim `diskBytes`, the executor
 * must remove EVERY local hardlink to the content: the by-hash file for each of
 * `exts`, plus all source-path hardlinks (queried from the media tables by
 * `content_hash`). Deleting only the by-hash entry frees nothing while a source
 * hardlink keeps the inode alive.
 */
export interface EvictionTarget {
  hash: string;
  /** Extensions present locally (one by-hash file each). */
  exts: string[];
  diskBytes: number;
}

export interface EvictionPlan {
  /** Blobs present in the local cache. */
  localBlobs: number;
  /** Actual on-disk bytes of the local cache (deduped by content hash). */
  localBytes: number;
  /** Local blobs also confirmed in R2 — the only ones safe to evict. */
  evictableBlobs: number;
  evictableBytes: number;
  /** Configured cache bound in bytes, or null when unset (report-only). */
  limitBytes: number | null;
  /** Blobs to evict (oldest cache mtime first) to reach the bound, in order. */
  selected: EvictionTarget[];
  /** = selected.length, summed bytes — derived for convenience. */
  toEvictBlobs: number;
  toEvictBytes: number;
  /** Local cache size after the planned eviction (assumes all hardlinks removed). */
  resultingBytes: number;
  /** Bytes still over the bound after evicting everything evictable (0 if reachable). */
  shortfallBytes: number;
  /**
   * How remote durability was checked. `targeted-head` confirms enough oldest
   * blobs for an execution plan without a full bucket inventory; `full-list`
   * computes the complete evictable set.
   */
  durabilityCheck: "none" | "full-list" | "targeted-head";
  /** Number of local blobs checked against the remote backend. */
  durabilityCheckedBlobs: number;
}

interface LocalBlob {
  hash: string;
  exts: string[];
  diskBytes: number;
  mtimeMs: number;
  inR2: boolean;
}

function assertLimitBytes(limitBytes: number | null): void {
  if (limitBytes !== null && (!Number.isFinite(limitBytes) || limitBytes < 0)) {
    throw new Error(`limitBytes must be null or a non-negative finite number, got ${limitBytes}`);
  }
}

async function collectLocalBlobs(
  db: Database,
  local: LocalStat,
  tables?: readonly MediaTable[],
): Promise<LocalBlob[]> {
  const { blobs } = collectMediaBlobs(db, tables);

  // Disk size + cache mtime per locally-present blob (a hash can occupy more than
  // one by-hash file across extensions; sum the sizes, take the newest mtime).
  const localBlobs: LocalBlob[] = [];
  for (const [hash, meta] of blobs) {
    const exts: string[] = [];
    let diskBytes = 0;
    let mtimeMs = 0;
    for (const ext of meta.exts) {
      const s = await local.statByHash(hash, ext);
      if (s) {
        exts.push(ext);
        diskBytes += s.size;
        mtimeMs = Math.max(mtimeMs, s.mtimeMs);
      }
    }
    if (exts.length > 0) localBlobs.push({ hash, exts, diskBytes, mtimeMs, inR2: false });
  }
  return localBlobs;
}

function buildEvictionPlan(
  localBlobs: LocalBlob[],
  evictable: LocalBlob[],
  limitBytes: number | null,
  durabilityCheck: EvictionPlan["durabilityCheck"],
  durabilityCheckedBlobs: number,
): EvictionPlan {
  const localBytes = localBlobs.reduce((sum, b) => sum + b.diskBytes, 0);
  const evictableBytes = evictable.reduce((sum, b) => sum + b.diskBytes, 0);

  const selected: EvictionTarget[] = [];
  let toEvictBytes = 0;
  let shortfallBytes = 0;
  if (limitBytes !== null && localBytes > limitBytes) {
    const need = localBytes - limitBytes;
    const oldestFirst = [...evictable].sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const b of oldestFirst) {
      if (toEvictBytes >= need) break;
      selected.push({ hash: b.hash, exts: b.exts, diskBytes: b.diskBytes });
      toEvictBytes += b.diskBytes;
    }
    shortfallBytes = Math.max(0, need - toEvictBytes);
  }

  return {
    localBlobs: localBlobs.length,
    localBytes,
    evictableBlobs: evictable.length,
    evictableBytes,
    limitBytes,
    selected,
    toEvictBlobs: selected.length,
    toEvictBytes,
    resultingBytes: localBytes - toEvictBytes,
    shortfallBytes,
    durabilityCheck,
    durabilityCheckedBlobs,
  };
}

async function planWithFullRemoteCheck(
  localBlobs: LocalBlob[],
  remote: RemoteBlobStore | null,
  limitBytes: number | null,
): Promise<EvictionPlan> {
  if (!remote) return buildEvictionPlan(localBlobs, [], limitBytes, "none", 0);

  // Only R2-durable blobs may be evicted (read-through restores them on demand).
  const present = await remote.presentHashes(localBlobs.map((b) => b.hash));
  for (const b of localBlobs) b.inR2 = present.has(b.hash);
  return buildEvictionPlan(
    localBlobs,
    localBlobs.filter((b) => b.inR2),
    limitBytes,
    "full-list",
    localBlobs.length,
  );
}

export async function planEviction(
  db: Database,
  local: LocalStat,
  remote: RemoteBlobStore | null,
  limitBytes: number | null,
  tables?: readonly MediaTable[],
): Promise<EvictionPlan> {
  assertLimitBytes(limitBytes);
  return planWithFullRemoteCheck(await collectLocalBlobs(db, local, tables), remote, limitBytes);
}

/** Every source-path hardlink for a content hash, across the media registry. */
function storagePathsForHash(
  db: Database,
  hash: string,
  tables: readonly MediaTable[],
): string[] {
  const paths = new Set<string>();
  for (const t of tables) {
    const rows = db
      .query(`SELECT ${t.pathCol} AS path FROM ${t.table} WHERE ${t.hashCol} = ? AND ${t.pathCol} IS NOT NULL`)
      .all(hash) as { path: string }[];
    for (const r of rows) paths.add(r.path);
  }
  return [...paths];
}

export interface EvictionResult extends EvictionPlan {
  /** Blobs actually deleted this run (0 on a dry run). */
  evicted: number;
  reclaimedBytes: number;
  /** Blobs whose deletion errored (e.g. a non-removable link); left for re-run. */
  failed: number;
}

async function planExecutableEviction(
  db: Database,
  local: LocalStat,
  remote: RemoteBlobStore | null,
  limitBytes: number | null,
  tables: readonly MediaTable[],
  targetedHeadCheckLimit: number,
): Promise<EvictionPlan> {
  assertLimitBytes(limitBytes);
  if (!Number.isInteger(targetedHeadCheckLimit) || targetedHeadCheckLimit < 0) {
    throw new Error(`targetedHeadCheckLimit must be a non-negative integer, got ${targetedHeadCheckLimit}`);
  }

  const localBlobs = await collectLocalBlobs(db, local, tables);
  if (!remote || limitBytes === null) {
    return planWithFullRemoteCheck(localBlobs, remote, limitBytes);
  }

  const localBytes = localBlobs.reduce((sum, b) => sum + b.diskBytes, 0);
  if (localBytes <= limitBytes) {
    return buildEvictionPlan(localBlobs, [], limitBytes, "targeted-head", 0);
  }

  const need = localBytes - limitBytes;
  const evictable: LocalBlob[] = [];
  let evictableBytes = 0;
  let checked = 0;
  for (const blob of [...localBlobs].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (checked >= targetedHeadCheckLimit) {
      return planWithFullRemoteCheck(localBlobs, remote, limitBytes);
    }
    checked++;
    if (await remote.has(blob.hash)) {
      blob.inR2 = true;
      evictable.push(blob);
      evictableBytes += blob.diskBytes;
      if (evictableBytes >= need) {
        return buildEvictionPlan(localBlobs, evictable, limitBytes, "targeted-head", checked);
      }
    }
  }

  return buildEvictionPlan(localBlobs, evictable, limitBytes, "targeted-head", checked);
}

/**
 * Plan eviction and, unless `dryRun`, delete the selected blobs. Planning runs
 * remote durability checks immediately before deletion, so `selected` is
 * confirmed durable in R2 at eviction time — only locally-cached, R2-backed blobs
 * are ever removed (read-through restores them on demand). Idempotent/resumable.
 */
export async function evictMedia(
  db: Database,
  local: LocalEvictor,
  remote: RemoteBlobStore | null,
  limitBytes: number | null,
  options: { dryRun?: boolean; tables?: readonly MediaTable[]; targetedHeadCheckLimit?: number } = {},
): Promise<EvictionResult> {
  const tables = options.tables ?? MEDIA_TABLES;
  const plan =
    options.dryRun === false
      ? await planExecutableEviction(
          db,
          local,
          remote,
          limitBytes,
          tables,
          options.targetedHeadCheckLimit ?? DEFAULT_TARGETED_EVICTION_HEAD_CHECK_LIMIT,
        )
      : await planEviction(db, local, remote, limitBytes, tables);

  let evicted = 0;
  let reclaimedBytes = 0;
  let failed = 0;
  if (options.dryRun === false) {
    for (const target of plan.selected) {
      try {
        await local.removeBlob(target.hash, target.exts, storagePathsForHash(db, target.hash, tables));
        evicted++;
        reclaimedBytes += target.diskBytes;
      } catch (err) {
        failed++;
        console.error(`[evict] failed to remove ${target.hash}:`, err);
      }
    }
  }

  return { ...plan, evicted, reclaimedBytes, failed };
}
