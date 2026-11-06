import type { PlatformModule } from "../registry";
import { t3codeMeta } from "./meta";
import { t3codeSyncSource } from "./sync";

export const t3codePlatform: PlatformModule = {
  meta: t3codeMeta,
  syncSources: [t3codeSyncSource],
  loadSeeds: async () => [(await import("./seed")).t3codeSeed],
};
