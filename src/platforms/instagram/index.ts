import type { PlatformModule } from "../registry";
import { instagramMeta } from "./meta";

export const instagramPlatform: PlatformModule = {
  meta: instagramMeta,
  loadSeeds: async () => [(await import("./seed")).instagramSeed],
};
