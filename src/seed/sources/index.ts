import { PLATFORMS } from "../../platforms";
import { collectSeedSources } from "../../platforms/registry";
import type { SeedSource } from "../context";
import { ampSeed } from "./amp";
import { chatgptSeed } from "./chatgpt";
import { claudeSeed } from "./claude";
import { claudeCodeSeed } from "./claude-code";
import { codexSeed } from "./codex";
import { conductorSeed } from "./conductor";
import { githubSeed } from "./github";
import { opencodeSeed } from "./opencode";
import { t3codeSeed } from "./t3code";
import { wakatimeSeed } from "./wakatime";

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
