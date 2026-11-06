import { discordPlatform } from "./discord";
import { googleMessagesPlatform } from "./google-messages";
import { minecraftPlatform } from "./minecraft";
import { spotifyPlatform } from "./spotify";
import { steamPlatform } from "./steam";
import { traktPlatform } from "./trakt";
import type { PlatformModule } from "./registry";

/** Server-only list of platforms, in the same relative order as `PLATFORM_METAS` in `metas.ts`. */
export const PLATFORMS: readonly PlatformModule[] = [
  discordPlatform,
  googleMessagesPlatform,
  traktPlatform,
  spotifyPlatform,
  steamPlatform,
  minecraftPlatform,
];
