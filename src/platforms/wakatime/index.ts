import type { PlatformModule } from "../registry";
import { wakatimeMeta } from "./meta";
import { wakatimeSyncSource } from "./sync";

export const wakatimePlatform: PlatformModule = {
  meta: wakatimeMeta,
  syncSources: [wakatimeSyncSource],
  loadSeeds: async () => [(await import("./seed")).wakatimeSeed],
};
