import type { PlatformModule } from "../registry";
import { jellyfinMeta } from "./meta";
import { jellyfinSyncSource } from "./sync";

export const jellyfinPlatform: PlatformModule = {
  meta: jellyfinMeta,
  syncSources: [jellyfinSyncSource],
  loadSeeds: async () => [(await import("./seed")).jellyfinSeed],
};
