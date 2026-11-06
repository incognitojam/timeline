import type { PlatformModule } from "../registry";
import { opencodeMeta } from "./meta";
import { opencodeSyncSource } from "./sync";

export const opencodePlatform: PlatformModule = {
  meta: opencodeMeta,
  syncSources: [opencodeSyncSource],
  loadSeeds: async () => [(await import("./seed")).opencodeSeed],
};
