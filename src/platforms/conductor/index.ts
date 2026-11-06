import type { PlatformModule } from "../registry";
import { conductorMeta } from "./meta";
import { conductorSyncSource } from "./sync";

export const conductorPlatform: PlatformModule = {
  meta: conductorMeta,
  syncSources: [conductorSyncSource],
  loadSeeds: async () => [(await import("./seed")).conductorSeed],
};
