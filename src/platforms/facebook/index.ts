import type { PlatformModule } from "../registry";
import { facebookMeta } from "./meta";

export const facebookPlatform: PlatformModule = {
  meta: facebookMeta,
  loadSeeds: async () => [(await import("./seed")).facebookSeed],
};
