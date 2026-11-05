import { discordPlatform } from "./discord";
import { googleMessagesPlatform } from "./google-messages";
import type { PlatformModule } from "./registry";

/** Server-only list of platforms, in the same order as `PLATFORM_METAS` in `metas.ts`. */
export const PLATFORMS: readonly PlatformModule[] = [discordPlatform, googleMessagesPlatform];
