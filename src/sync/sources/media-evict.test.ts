import { describe, test, expect, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../../config";
import { deleteSyncState, getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
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
    const priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    const appDb = getAppStateDb();
    const previousState = getSyncState(appDb, "media-evict");
    const mediaPath = mkdtempSync(join(tmpdir(), "media-evict-"));
    process.env.TIMELINE_MEDIA_PATH = mediaPath;
    const db = getDb();
    let eventId: number | undefined;
    try {
      initDb(db);
      // A cached blob with no remote copy: evicting it would lose it.
      const stored = await new LocalMediaStore(mediaPath).storeFile({
        source: "discord",
        relativePath: "media-evict/only-copy.png",
        content: Buffer.from("the only copy"),
      });
      eventId = (
        db
          .prepare(
            "INSERT INTO events (source, source_id, source_account, type, raw_data) VALUES ('discord', 'media-evict-noop', 'test', 'message:dm', '{}') RETURNING id",
          )
          .get() as { id: number }
      ).id;
      db.prepare(
        "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, status) VALUES (?, 'discord', 'media-evict-noop', ?, ?, 'stored')",
      ).run(eventId, stored.hash, stored.storagePath);

      const result = await mediaEvictSyncSource.sync({
        verbose: false,
        config: { sources: {} },
      } as unknown as SyncOptions);
      expect(result.source).toBe("media-evict");
      expect(result.success).toBe(true);
      expect(result.eventsUpdated).toBe(0);
      // The run saw the blob and left it in place.
      expect(result.metadata).toMatchObject({ localBlobs: 1, evicted: 0, limitBytes: null });
      expect(existsSync(join(mediaPath, stored.storagePath))).toBe(true);
    } finally {
      if (eventId !== undefined) {
        db.prepare("DELETE FROM attachments WHERE event_id = ?").run(eventId);
        db.prepare("DELETE FROM events WHERE id = ?").run(eventId);
      }
      db.close();
      if (previousState === null) deleteSyncState(appDb, "media-evict");
      else setSyncState(appDb, "media-evict", previousState);
      if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
      else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
      rmSync(mediaPath, { recursive: true, force: true });
    }
  });
});
