import type { PlatformModule } from "../registry";
import { skypeMeta } from "./meta";

export const skypePlatform: PlatformModule = {
  meta: skypeMeta,
  loadSeeds: async () => [(await import("./seed")).skypeSeed],
};
