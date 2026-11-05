import { discordMeta } from "./discord/meta";
import { googleMessagesMeta } from "./google-messages/meta";
import type { PlatformMeta } from "./types";

/** Web-safe list of platforms, in the same order as `PLATFORMS` in `index.ts`. */
export const PLATFORM_METAS: readonly PlatformMeta[] = [discordMeta, googleMessagesMeta];
