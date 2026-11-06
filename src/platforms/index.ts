import { amexPlatform } from "./amex";
import { ampPlatform } from "./amp";
import { chatgptPlatform } from "./chatgpt";
import { claudePlatform } from "./claude";
import { claudeCodePlatform } from "./claude-code";
import { codexPlatform } from "./codex";
import { conductorPlatform } from "./conductor";
import { discordPlatform } from "./discord";
import { facebookPlatform } from "./facebook";
import { githubPlatform } from "./github";
import { googlePlatform } from "./google";
import { googleMessagesPlatform } from "./google-messages";
import { instagramPlatform } from "./instagram";
import { linkedinPlatform } from "./linkedin";
import { minecraftPlatform } from "./minecraft";
import { monzoPlatform } from "./monzo";
import { opencodePlatform } from "./opencode";
import { phonePlatform } from "./phone";
import { recallPlatform } from "./recall";
import { redditPlatform } from "./reddit";
import { skypePlatform } from "./skype";
import { spotifyPlatform } from "./spotify";
import { steamPlatform } from "./steam";
import { swarmPlatform } from "./swarm";
import { t3codePlatform } from "./t3code";
import { thrivaPlatform } from "./thriva";
import { traktPlatform } from "./trakt";
import { wakatimePlatform } from "./wakatime";
import type { PlatformModule } from "./registry";

/** Server-only list of platforms, in the same relative order as `PLATFORM_METAS` in `metas.ts`. */
export const PLATFORMS: readonly PlatformModule[] = [
  discordPlatform,
  googleMessagesPlatform,
  monzoPlatform,
  traktPlatform,
  swarmPlatform,
  wakatimePlatform,
  githubPlatform,
  claudeCodePlatform,
  ampPlatform,
  thrivaPlatform,
  googlePlatform,
  opencodePlatform,
  spotifyPlatform,
  conductorPlatform,
  t3codePlatform,
  codexPlatform,
  steamPlatform,
  facebookPlatform,
  instagramPlatform,
  skypePlatform,
  phonePlatform,
  linkedinPlatform,
  redditPlatform,
  claudePlatform,
  chatgptPlatform,
  minecraftPlatform,
  amexPlatform,
  recallPlatform,
];
