import type { PlatformModule } from "../registry";
import { googleMessagesMeta } from "./meta";
import { googleMessagesSyncSource } from "./sync";

export const googleMessagesPlatform: PlatformModule = {
  meta: googleMessagesMeta,
  syncSources: [googleMessagesSyncSource],
  loadSeeds: async () => [(await import("./seed")).googleMessagesSeed],
};
