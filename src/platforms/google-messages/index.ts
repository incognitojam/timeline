import type { PlatformModule } from "../registry";
import { googleMessagesMeta } from "./meta";
import { googleMessagesRefresh, googleMessagesSyncSource } from "./sync";

export const googleMessagesPlatform: PlatformModule = {
  conversationRefresh: googleMessagesRefresh,
  meta: googleMessagesMeta,
  syncSources: [googleMessagesSyncSource],
  loadSeeds: async () => [(await import("./seed")).googleMessagesSeed],
};
