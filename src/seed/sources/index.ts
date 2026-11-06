import { PLATFORMS } from "../../platforms";
import { collectSeedSources } from "../../platforms/registry";
import type { SeedSource } from "../context";
import { amexSeed } from "./amex";
import { ampSeed } from "./amp";
import { chatgptSeed } from "./chatgpt";
import { claudeSeed } from "./claude";
import { claudeCodeSeed } from "./claude-code";
import { codexSeed } from "./codex";
import { conductorSeed } from "./conductor";
import { facebookSeed } from "./facebook";
import { fitbitSeed } from "./fitbit";
import { githubSeed } from "./github";
import { googleCalendarSeed } from "./google-calendar";
import { googleChatSeed } from "./google-chat";
import { googleChromeSeed } from "./google-chrome";
import { googleFitSeed } from "./google-fit";
import { googleHealthSeed } from "./google-health";
import { googleKeepSeed } from "./google-keep";
import { googleLocationSeed } from "./google-location";
import { googlePlaystoreSeed } from "./google-playstore";
import { googleSearchSeed } from "./google-search";
import { googleTimelineSeed } from "./google-timeline";
import { googleYoutubeSeed } from "./google-youtube";
import { instagramSeed } from "./instagram";
import { linkedinSeed } from "./linkedin";
import { monzoSeed } from "./monzo";
import { opencodeSeed } from "./opencode";
import { redditSeed } from "./reddit";
import { skypeSeed } from "./skype";
import { smsBackupRestoreSeed } from "./sms-backup-restore";
import { swarmSeed } from "./swarm";
import { t3codeSeed } from "./t3code";
import { thrivaSeed } from "./thriva";
import { wakatimeSeed } from "./wakatime";

/** Every generator, in run order. */
export const SEED_SOURCES: readonly SeedSource[] = await collectSeedSources(PLATFORMS, [
  facebookSeed,
  instagramSeed,
  googleChatSeed,
  skypeSeed,
  smsBackupRestoreSeed,
  linkedinSeed,
  redditSeed,
  claudeSeed,
  chatgptSeed,
  claudeCodeSeed,
  ampSeed,
  opencodeSeed,
  conductorSeed,
  t3codeSeed,
  codexSeed,
  wakatimeSeed,
  githubSeed,
  googleSearchSeed,
  googleYoutubeSeed,
  googleChromeSeed,
  googleFitSeed,
  googleLocationSeed,
  googleTimelineSeed,
  googleCalendarSeed,
  googleKeepSeed,
  googlePlaystoreSeed,
  swarmSeed,
  monzoSeed,
  amexSeed,
  fitbitSeed,
  googleHealthSeed,
  thrivaSeed,
]);
