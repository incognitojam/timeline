import type { PlatformModule } from "../registry";
import { thrivaMeta } from "./meta";
import { thrivaSyncSource } from "./sync";

export const thrivaPlatform: PlatformModule = {
  meta: thrivaMeta,
  syncSources: [thrivaSyncSource],
  loadSeeds: async () => [(await import("./seed")).thrivaSeed],
};
