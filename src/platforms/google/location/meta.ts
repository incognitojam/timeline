import type { PlatformSource } from "../../types";

export const locationSources = [
  {
    id: "google-location",
    label: "Google Location",
    eventTypes: ["location:visit", "location:transit"],
  },
  {
    id: "google-timeline",
    label: "Google Timeline",
  },
  {
    id: "google-location-sharing",
    label: "Google Location Sharing",
    legacyEventTypes: ["location:shared"],
  },
] as const satisfies readonly PlatformSource[];
