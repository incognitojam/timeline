import type { PlatformModule } from "../registry";
import { githubMeta } from "./meta";
import { githubSyncSource } from "./sync";

export const githubPlatform: PlatformModule = {
  meta: githubMeta,
  syncSources: [githubSyncSource],
  loadSeeds: async () => [(await import("./seed")).githubSeed],
};
