import { amexDisplay } from "./amex";
import { ampDisplay } from "./amp";
import { chatgptDisplay } from "./chatgpt";
import { claudeDisplay } from "./claude";
import { claudeCodeDisplay } from "./claude-code";
import { codexDisplay } from "./codex";
import { conductorDisplay } from "./conductor";
import { discordDisplay } from "./discord";
import { facebookDisplay } from "./facebook";
import { githubDisplay } from "./github";
import { googleDisplay } from "./google";
import { googleMessagesDisplay } from "./google-messages";
import { instagramDisplay } from "./instagram";
import { linkedinDisplay } from "./linkedin";
import { minecraftDisplay } from "./minecraft";
import { monzoDisplay } from "./monzo";
import { opencodeDisplay } from "./opencode";
import { phoneDisplay } from "./phone";
import { recallDisplay } from "./recall";
import { redditDisplay } from "./reddit";
import { skypeDisplay } from "./skype";
import { spotifyDisplay } from "./spotify";
import { steamDisplay } from "./steam";
import { swarmDisplay } from "./swarm";
import { t3codeDisplay } from "./t3code";
import { thrivaDisplay } from "./thriva";
import { traktDisplay } from "./trakt";
import { wakatimeDisplay } from "./wakatime";
import type { PlatformDisplay } from "./types";

/** In the same order as `PLATFORM_METAS` in `src/platforms/metas.ts`. */
export const PLATFORM_DISPLAYS: readonly PlatformDisplay[] = [
  discordDisplay,
  googleMessagesDisplay,
  monzoDisplay,
  traktDisplay,
  swarmDisplay,
  wakatimeDisplay,
  githubDisplay,
  claudeCodeDisplay,
  ampDisplay,
  thrivaDisplay,
  googleDisplay,
  opencodeDisplay,
  spotifyDisplay,
  conductorDisplay,
  t3codeDisplay,
  codexDisplay,
  steamDisplay,
  facebookDisplay,
  instagramDisplay,
  skypeDisplay,
  phoneDisplay,
  linkedinDisplay,
  redditDisplay,
  claudeDisplay,
  chatgptDisplay,
  minecraftDisplay,
  amexDisplay,
  recallDisplay,
];
