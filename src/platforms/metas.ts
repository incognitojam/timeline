import { amexMeta } from "./amex/meta";
import { ampMeta } from "./amp/meta";
import { chatgptMeta } from "./chatgpt/meta";
import { claudeMeta } from "./claude/meta";
import { claudeCodeMeta } from "./claude-code/meta";
import { codexMeta } from "./codex/meta";
import { conductorMeta } from "./conductor/meta";
import { discordMeta } from "./discord/meta";
import { facebookMeta } from "./facebook/meta";
import { githubMeta } from "./github/meta";
import { googleMeta } from "./google/meta";
import { googleMessagesMeta } from "./google-messages/meta";
import { instagramMeta } from "./instagram/meta";
import { linkedinMeta } from "./linkedin/meta";
import { minecraftMeta } from "./minecraft/meta";
import { monzoMeta } from "./monzo/meta";
import { opencodeMeta } from "./opencode/meta";
import { phoneMeta } from "./phone/meta";
import { recallMeta } from "./recall/meta";
import { redditMeta } from "./reddit/meta";
import { skypeMeta } from "./skype/meta";
import { spotifyMeta } from "./spotify/meta";
import { steamMeta } from "./steam/meta";
import { swarmMeta } from "./swarm/meta";
import { t3codeMeta } from "./t3code/meta";
import { thrivaMeta } from "./thriva/meta";
import { traktMeta } from "./trakt/meta";
import { wakatimeMeta } from "./wakatime/meta";
import type { PlatformMeta } from "./types";

/**
 * Every platform. Order sets the order of lists derived from this one, and
 * `CODING_AGENT_SOURCES` is written into trigger SQL, so a reorder can rebuild triggers.
 */
export const PLATFORM_METAS = [
  discordMeta,
  googleMessagesMeta,
  monzoMeta,
  traktMeta,
  swarmMeta,
  wakatimeMeta,
  githubMeta,
  claudeCodeMeta,
  ampMeta,
  thrivaMeta,
  googleMeta,
  opencodeMeta,
  spotifyMeta,
  conductorMeta,
  t3codeMeta,
  codexMeta,
  steamMeta,
  facebookMeta,
  instagramMeta,
  skypeMeta,
  phoneMeta,
  linkedinMeta,
  redditMeta,
  claudeMeta,
  chatgptMeta,
  minecraftMeta,
  amexMeta,
  recallMeta,
] as const satisfies readonly PlatformMeta[];
