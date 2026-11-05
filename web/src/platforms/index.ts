import { discordDisplay } from "./discord";
import { googleMessagesDisplay } from "./google-messages";
import type { PlatformDisplay } from "./types";

/** In the same order as `PLATFORM_METAS` in `src/platforms/metas.ts`. */
export const PLATFORM_DISPLAYS: readonly PlatformDisplay[] = [discordDisplay, googleMessagesDisplay];
