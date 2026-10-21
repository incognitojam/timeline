import { describe, test, expect } from "bun:test";
import { mediaEvictSyncSource } from "./media-evict";
import type { SyncOptions } from "../types";

describe("mediaEvictSyncSource", () => {
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
