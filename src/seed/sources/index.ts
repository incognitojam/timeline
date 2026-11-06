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
import { fitbitSeed } from "../../platforms/google/fitbit/seed";
import { githubSeed } from "./github";
import { googleCalendarSeed } from "../../platforms/google/calendar/seed";
import { googleChatSeed } from "../../platforms/google/chat/seed";
import { googleChromeSeed } from "../../platforms/google/chrome/seed";
import { googleFitSeed } from "../../platforms/google/fit/seed";
import { googleHealthSeed } from "../../platforms/google/health/seed";
import { googleKeepSeed } from "../../platforms/google/keep/seed";
import { googleLocationSeed } from "../../platforms/google/location/seed";
import { googlePlaystoreSeed } from "../../platforms/google/playstore/seed";
import { googleSearchSeed } from "../../platforms/google/search/seed";
import { googleTimelineSeed } from "../../platforms/google/location/seed-timeline";
import { googleYoutubeSeed } from "../../platforms/google/youtube/seed";
import { monzoSeed } from "./monzo";
import { opencodeSeed } from "./opencode";
import { smsBackupRestoreSeed } from "./sms-backup-restore";
import { t3codeSeed } from "./t3code";
import { thrivaSeed } from "./thriva";
import { wakatimeSeed } from "./wakatime";

/** Every generator, in run order. */
export const SEED_SOURCES: readonly SeedSource[] = await collectSeedSources(PLATFORMS, [
  googleChatSeed,
  smsBackupRestoreSeed,
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
  monzoSeed,
  amexSeed,
  fitbitSeed,
  googleHealthSeed,
  thrivaSeed,
]);
