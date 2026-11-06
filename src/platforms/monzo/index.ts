import type { PlatformModule } from "../registry";
import { monzoMeta } from "./meta";
import { monzoSyncSource } from "./sync";

export const monzoPlatform: PlatformModule = {
  meta: monzoMeta,
  syncSources: [monzoSyncSource],
  loadSeeds: async () => [(await import("./seed")).monzoSeed],
};
