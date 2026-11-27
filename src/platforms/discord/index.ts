import type { PlatformModule } from "../registry";
import { discordDmsSyncSource } from "./dm-pass";
import { discordMeta } from "./meta";
import { renderDiscordEvent } from "./render";
import { discordSyncSource } from "./sync";

export const discordPlatform: PlatformModule = {
  meta: discordMeta,
  syncSources: [discordSyncSource, discordDmsSyncSource],
  renderers: { discord: { version: 2, render: renderDiscordEvent } },
  loadSeeds: async () => [(await import("./seed")).discordSeed],
};
