import type { PlatformModule } from "../registry";
import { minecraftMeta } from "./meta";

export const minecraftPlatform: PlatformModule = {
  meta: minecraftMeta,
  loadSeeds: async () => [(await import("./seed")).minecraftSeed],
};
