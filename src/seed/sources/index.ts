import { PLATFORMS } from "../../platforms";
import { collectSeedSources } from "../../platforms/registry";
import type { SeedSource } from "../context";
import { ampSeed } from "../../platforms/amp/seed";
import { chatgptSeed } from "../../platforms/chatgpt/seed";
import { claudeSeed } from "../../platforms/claude/seed";
import { claudeCodeSeed } from "../../platforms/claude-code/seed";
import { codexSeed } from "../../platforms/codex/seed";
import { conductorSeed } from "../../platforms/conductor/seed";
import { githubSeed } from "../../platforms/github/seed";
import { opencodeSeed } from "../../platforms/opencode/seed";
import { t3codeSeed } from "../../platforms/t3code/seed";
import { wakatimeSeed } from "../../platforms/wakatime/seed";

/** Every generator, in run order. */
export const SEED_SOURCES: readonly SeedSource[] = await collectSeedSources(PLATFORMS, [
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
]);
