import type { PlatformModule } from "../registry";
import { discordMeta } from "./meta";
import { renderDiscordEvent } from "./render";
import { discordSyncSource } from "./sync";

export const discordPlatform: PlatformModule = {
  meta: discordMeta,
  syncSources: [discordSyncSource],
  renderers: { discord: { version: 2, render: renderDiscordEvent } },
  loadSeeds: async () => [(await import("./seed")).discordSeed],
};
