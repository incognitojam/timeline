import type { PlatformModule } from "../registry";
import { chatgptMeta } from "./meta";

export const chatgptPlatform: PlatformModule = {
  meta: chatgptMeta,
  loadSeeds: async () => [(await import("./seed")).chatgptSeed],
};
