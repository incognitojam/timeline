import { amexPlatform } from "./amex";
import { discordPlatform } from "./discord";
import { facebookPlatform } from "./facebook";
import { googlePlatform } from "./google";
import { googleMessagesPlatform } from "./google-messages";
import { instagramPlatform } from "./instagram";
import { linkedinPlatform } from "./linkedin";
import { minecraftPlatform } from "./minecraft";
import { redditPlatform } from "./reddit";
import { skypePlatform } from "./skype";
import { spotifyPlatform } from "./spotify";
import { steamPlatform } from "./steam";
import { swarmPlatform } from "./swarm";
import { thrivaPlatform } from "./thriva";
import { traktPlatform } from "./trakt";
import type { PlatformModule } from "./registry";

/** Server-only list of platforms, in the same relative order as `PLATFORM_METAS` in `metas.ts`. */
export const PLATFORMS: readonly PlatformModule[] = [
  discordPlatform,
  googleMessagesPlatform,
  traktPlatform,
  swarmPlatform,
  thrivaPlatform,
  googlePlatform,
  spotifyPlatform,
  steamPlatform,
  facebookPlatform,
  instagramPlatform,
  skypePlatform,
  linkedinPlatform,
  redditPlatform,
  minecraftPlatform,
  amexPlatform,
];
