import { googleMeta } from "@platforms/google/meta";
import {
  IconFavorite,
  IconFitbit,
  IconGoogle,
  IconGoogleCalendar,
  IconGoogleChat,
  IconGoogleChrome,
  IconGoogleFit,
  IconGoogleKeep,
  IconGooglePlay,
  IconLocationOn,
  IconSearch,
  IconYouTube,
} from "../../ui/icons";
import type { PlatformDisplay } from "../types";

export const googleDisplay: PlatformDisplay<typeof googleMeta> = {
  meta: googleMeta,
  icon: IconGoogle,
  sourceIcons: {
    "google-calendar": IconGoogleCalendar,
    "google-keep": IconGoogleKeep,
    "google-chat": IconGoogleChat,
    "google-fit": IconGoogleFit,
    "google-search": IconSearch,
    "google-playstore": IconGooglePlay,
    chrome: IconGoogleChrome,
    youtube: IconYouTube,
    "google-location": IconLocationOn,
    "google-timeline": IconLocationOn,
    "google-location-sharing": IconLocationOn,
    fitbit: IconFitbit,
    "google-health": IconFavorite,
  },
};
