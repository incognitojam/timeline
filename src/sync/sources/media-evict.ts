/**
 * Media Cache Eviction Sync Source
 *
 * Periodically evicts the oldest R2-durable media blobs to leave headroom below
 * [media].cache_limit_gib once that limit is exceeded. A local maintenance job (like thumbhash), not
 * an external sync — read-through restores any evicted blob from R2 on demand.
 * Opt-in: only runs when a `[sync.media-evict]` section schedules it.
 */

import { getDb, initDb } from "../../db/schema";
import { getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { resolve } from "node:path";
import { loadConfig } from "../../config";
import { LocalMediaStore } from "../../media/storage";
import { createR2BlobStore } from "../../media/r2";
import { cacheLimitBytes, evictMediaIfNeeded } from "../../media/eviction";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

interface EvictionState {
  lastInventoryAt: number;
  mediaRoot: string;
  limitBytes: number | null;
}

export const mediaEvictSyncSource: SyncSource = {
  name: "media-evict",
  description: "Evict oldest R2-durable media to leave headroom below the cache limit",
  enabled: true,

  async canSync(sourceConfig?: Record<string, unknown>): Promise<string | null> {
    // Eviction is destructive and opt-in: require an explicit [sync.media-evict]
    // section, so it never runs from `sync --only media-evict` without one (the
    // scheduler already only schedules configured sources). The bound itself
    // lives in [media], so without this check eviction would run unconfigured.
    if (!sourceConfig) {
      return "no [sync.media-evict] section configured; eviction is opt-in";
    }
    const config = await loadConfig();
    if (!config.media.r2?.enabled) {
      return "R2 not enabled; eviction needs a durable copy to restore from";
    }
    if (config.media.cache_limit_gib === undefined) {
      return "no [media].cache_limit_gib set; the local cache is unbounded";
    }
    return null;
  },

  async sync(_options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const config = await loadConfig();
    const limitBytes = cacheLimitBytes(config.media);
    const local = new LocalMediaStore(config.media.path);
    const remote = config.media.r2?.enabled ? createR2BlobStore(config.media.r2) : null;

    const db = getDb();
    try {
      initDb(db);
      const appDb = getAppStateDb();
      const state = getSyncState<EvictionState>(appDb, "media-evict");
      const mediaRoot = resolve(config.media.path);
      const lastInventoryAt = state?.mediaRoot === mediaRoot && state.limitBytes === limitBytes
        && typeof state.lastInventoryAt === "number" ? state.lastInventoryAt : null;
      const result = await evictMediaIfNeeded(db, local, remote, limitBytes, lastInventoryAt);
      if ("inventorySkipped" in result) {
        return {
          source: "media-evict",
          success: true,
          eventsAdded: 0,
          eventsUpdated: 0,
          durationMs: Date.now() - startTime,
          // Do not report the estimate as an exact inventory gauge.
          metadata: { ...result, evicted: 0, reclaimedBytes: 0, failed: 0 },
        };
      }
      if (result.failed === 0) {
        setSyncState(appDb, "media-evict", { lastInventoryAt: startTime, mediaRoot, limitBytes } satisfies EvictionState);
      }
      return {
        source: "media-evict",
        success: result.failed === 0,
        eventsAdded: 0,
        eventsUpdated: result.evicted,
        durationMs: Date.now() - startTime,
        // Cache gauge for the sync_log row (shown in SyncSourceDetailView).
        // `durabilityCheck` records whether evictable* is a full inventory or
        // just the targeted durable set confirmed for this execution.
        metadata: {
          evicted: result.evicted,
          reclaimedBytes: result.reclaimedBytes,
          failed: result.failed,
          localBlobs: result.localBlobs,
          localBytes: result.localBytes,
          evictableBlobs: result.evictableBlobs,
          evictableBytes: result.evictableBytes,
          limitBytes: result.limitBytes,
          targetBytes: result.targetBytes,
          durabilityCheck: result.durabilityCheck,
          durabilityCheckedBlobs: result.durabilityCheckedBlobs,
        },
      };
    } catch (err) {
      return {
        source: "media-evict",
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
