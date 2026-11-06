import type { PlatformModule } from "../registry";
import { swarmMeta } from "./meta";
import { swarmSyncSource } from "./sync";

export const swarmPlatform: PlatformModule = {
  meta: swarmMeta,
  syncSources: [swarmSyncSource],
  loadSeeds: async () => [(await import("./seed")).swarmSeed],
};
