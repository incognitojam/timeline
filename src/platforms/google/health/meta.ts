import type { PlatformSource } from "../../types";

export const healthSources = [
  {
    id: "google-health",
    label: "Google Health",
    color: "#00B0B9",
    eventTypes: [
      "sleep",
      "sleep:nap",
      "daily:activity",
      "daily:azm",
      "daily:breathing",
      "daily:heart",
      "daily:hrv",
      "daily:spo2",
      "daily:temperature",
      "daily:weight",
    ],
  },
] as const satisfies readonly PlatformSource[];
