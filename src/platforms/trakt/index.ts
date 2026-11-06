import type { PlatformModule } from "../registry";
import { traktMeta } from "./meta";
import { traktSyncSource } from "./sync";

export const traktPlatform: PlatformModule = {
  meta: traktMeta,
  syncSources: [traktSyncSource],
  loadSeeds: async () => [(await import("./seed")).traktSeed],
};
