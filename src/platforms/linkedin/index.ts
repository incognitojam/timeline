import type { PlatformModule } from "../registry";
import { linkedinMeta } from "./meta";

export const linkedinPlatform: PlatformModule = {
  meta: linkedinMeta,
  loadSeeds: async () => [(await import("./seed")).linkedinSeed],
};
