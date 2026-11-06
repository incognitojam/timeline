import type { PlatformModule } from "../registry";
import { amexMeta } from "./meta";

export const amexPlatform: PlatformModule = {
  meta: amexMeta,
  loadSeeds: async () => [(await import("./seed")).amexSeed],
};
