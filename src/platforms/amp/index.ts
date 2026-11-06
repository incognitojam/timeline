import type { PlatformModule } from "../registry";
import { ampMeta } from "./meta";
import { ampSyncSource } from "./sync";

export const ampPlatform: PlatformModule = {
  meta: ampMeta,
  syncSources: [ampSyncSource],
  loadSeeds: async () => [(await import("./seed")).ampSeed],
};
