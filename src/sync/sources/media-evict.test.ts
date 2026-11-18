import { describe, test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../../config";
import { deleteSyncState, getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { LocalMediaStore } from "../../media/storage";
import { MEDIA_EVICTION_RECONCILE_MS } from "../../media/eviction";
import { mediaEvictSyncSource } from "./media-evict";
import type { SyncOptions } from "../types";

describe("mediaEvictSyncSource", () => {
  test("persists reconciliation across store instances and records estimates only on skipped inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "eviction-sync-"));
    const appDb = getAppStateDb();
    const previous = getSyncState(appDb, "media-evict");
    const config = await configModule.loadConfig();
    const load = spyOn(configModule, "loadConfig").mockResolvedValue({
      ...config, media: { ...config.media, path: root, cache_limit_gib: 1, r2: undefined },
    });
    try {
      await new LocalMediaStore(root).storeFile({ source: "discord", relativePath: "synthetic.png", content: Buffer.alloc(100) });
      deleteSyncState(appDb, "media-evict");
      const run = () => mediaEvictSyncSource.sync({ verbose: false, config: { sources: {} } } as unknown as SyncOptions);
      const first = await run();
      expect(first.success).toBe(true);
      expect(first.metadata).toHaveProperty("localBytes");
      const state = getSyncState<{ lastInventoryAt: number; mediaRoot: string; limitBytes: number }>(appDb, "media-evict")!;
      expect(state.mediaRoot).toBe(root);
      expect(state.limitBytes).toBe(1024 ** 3);

      const skipped = await run();
      expect(skipped).toMatchObject({ success: true, eventsUpdated: 0, metadata: { inventorySkipped: true, evicted: 0 } });
      expect(skipped.metadata?.estimatedCacheBytes).toBeGreaterThanOrEqual(100);
      expect(skipped.metadata).not.toHaveProperty("localBytes");
      expect(getSyncState<typeof state>(appDb, "media-evict")).toEqual(state);

      setSyncState(appDb, "media-evict", { ...state, lastInventoryAt: Date.now() - MEDIA_EVICTION_RECONCILE_MS });
      expect((await run()).metadata).toHaveProperty("localBytes");
      const renewed = getSyncState<{ lastInventoryAt: number }>(appDb, "media-evict")!;
      expect(renewed.lastInventoryAt).toBeGreaterThanOrEqual(state.lastInventoryAt);

      for (const changed of [{ mediaRoot: `${root}/other` }, { limitBytes: 1 }]) {
        setSyncState(appDb, "media-evict", { ...state, ...changed });
        expect((await run()).metadata).toHaveProperty("localBytes");
      }
    } finally {
      load.mockRestore();
      if (previous === null) deleteSyncState(appDb, "media-evict");
      else setSyncState(appDb, "media-evict", previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("canSync requires an explicit [sync.media-evict] section (opt-in)", async () => {
    expect(await mediaEvictSyncSource.canSync()).toMatch(/no \[sync\.media-evict\]/);
  });

  test("canSync skips when R2 is not enabled", async () => {
    // Pass a config section so it gets past the opt-in check; the hermetic test
    // config has no [media.r2], so eviction has no durable copy and must not run.
    expect(await mediaEvictSyncSource.canSync({})).toMatch(/R2 not enabled/);
  });

  test("sync is a clean no-op when nothing is configured", async () => {
    const result = await mediaEvictSyncSource.sync({
      verbose: false,
      config: { sources: {} },
    } as unknown as SyncOptions);
    expect(result.source).toBe("media-evict");
    expect(result.success).toBe(true);
    expect(result.eventsUpdated).toBe(0);
  });
});
