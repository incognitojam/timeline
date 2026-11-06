import { PLATFORMS } from "../../platforms";
import { collectSeedSources } from "../../platforms/registry";
import type { SeedSource } from "../context";

/** Every generator, in run order. */
export const SEED_SOURCES: readonly SeedSource[] = await collectSeedSources(PLATFORMS);
