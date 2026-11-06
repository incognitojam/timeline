import type { PlatformModule } from "../registry";
import { googleMeta } from "./meta";
import { googleHealthSyncSource } from "./health/sync";

export const googlePlatform: PlatformModule = {
  meta: googleMeta,
  syncSources: [googleHealthSyncSource],
  loadSeeds: async () => [
    (await import("./chat/seed")).googleChatSeed,
    (await import("./search/seed")).googleSearchSeed,
    (await import("./youtube/seed")).googleYoutubeSeed,
    (await import("./chrome/seed")).googleChromeSeed,
    (await import("./fit/seed")).googleFitSeed,
    (await import("./location/seed")).googleLocationSeed,
    (await import("./location/seed-timeline")).googleTimelineSeed,
    (await import("./calendar/seed")).googleCalendarSeed,
    (await import("./keep/seed")).googleKeepSeed,
    (await import("./playstore/seed")).googlePlaystoreSeed,
    (await import("./fitbit/seed")).fitbitSeed,
    (await import("./health/seed")).googleHealthSeed,
  ],
};
