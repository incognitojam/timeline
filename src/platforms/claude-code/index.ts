import type { PlatformModule } from "../registry";
import { claudeCodeMeta } from "./meta";
import { claudeCodeSyncSource } from "./sync";

export const claudeCodePlatform: PlatformModule = {
  meta: claudeCodeMeta,
  syncSources: [claudeCodeSyncSource],
  loadSeeds: async () => [(await import("./seed")).claudeCodeSeed],
};
