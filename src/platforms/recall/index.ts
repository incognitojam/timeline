import type { PlatformModule } from "../registry";
import { recallMeta } from "./meta";
import { recallSyncSource } from "./sync";

export const recallPlatform: PlatformModule = {
  meta: recallMeta,
  syncSources: [recallSyncSource],
};
