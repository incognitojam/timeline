import type { PlatformModule } from "../registry";
import { codexMeta } from "./meta";
import { codexSyncSource } from "./sync";

export const codexPlatform: PlatformModule = {
  meta: codexMeta,
  syncSources: [codexSyncSource],
  loadSeeds: async () => [(await import("./seed")).codexSeed],
};
