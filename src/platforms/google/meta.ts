import type { PlatformMeta } from "../types";
import { calendarSources } from "./calendar/meta";
import { chatSources } from "./chat/meta";
import { chromeSources } from "./chrome/meta";
import { fitSources } from "./fit/meta";
import { fitbitSources } from "./fitbit/meta";
import { healthSources } from "./health/meta";
import { keepSources } from "./keep/meta";
import { locationSources } from "./location/meta";
import { playstoreSources } from "./playstore/meta";
import { searchSources } from "./search/meta";
import { youtubeSources } from "./youtube/meta";

export const googleMeta = {
  id: "google",
  color: "#EA4335",
  sources: [
    { id: "google", label: "Google" },
    { id: "google-takeout", label: "Google Takeout" },
    ...calendarSources,
    ...keepSources,
    ...chatSources,
    ...fitSources,
    ...searchSources,
    ...playstoreSources,
    ...chromeSources,
    ...youtubeSources,
    ...locationSources,
    ...fitbitSources,
    ...healthSources,
  ],
  identityPlatforms: ["google-calendar", "google-chat", "youtube"],
} as const satisfies PlatformMeta;
