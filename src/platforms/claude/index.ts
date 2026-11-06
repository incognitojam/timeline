import type { PlatformModule } from "../registry";
import { claudeMeta } from "./meta";

export const claudePlatform: PlatformModule = {
  meta: claudeMeta,
  loadSeeds: async () => [(await import("./seed")).claudeSeed],
};
