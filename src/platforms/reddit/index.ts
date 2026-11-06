import type { PlatformModule } from "../registry";
import { redditMeta } from "./meta";

export const redditPlatform: PlatformModule = {
  meta: redditMeta,
  loadSeeds: async () => [(await import("./seed")).redditSeed],
};
