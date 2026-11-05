import type { PlatformSource } from "../../types";

export const fitbitSources = [
  {
    id: "fitbit",
    label: "Fitbit",
    color: "#00B0B9",
    eventTypes: [
      "sleep",
      "sleep:nap",
      "daily:breathing",
      "daily:hrv",
      "daily:readiness",
      "daily:spo2",
      "daily:stress",
    ],
    legacyEventTypes: [
      "daily:activity",
      "daily:azm",
      "daily:food",
      "daily:heart",
      "daily:temperature",
      "daily:vo2max",
      "daily:weight",
    ],
  },
] as const satisfies readonly PlatformSource[];
