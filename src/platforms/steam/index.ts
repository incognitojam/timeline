import type { PlatformModule } from "../registry";
import { steamMeta } from "./meta";
import { steamSyncSource } from "./sync";

export const steamPlatform: PlatformModule = {
  meta: steamMeta,
  syncSources: [steamSyncSource],
};
