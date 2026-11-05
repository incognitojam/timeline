import type { PlatformSource } from "../../types";

export const playstoreSources = [
  {
    id: "google-playstore",
    label: "Google Play Store",
    traits: { session: { gapMinutes: 30 } },
    color: "#01875f",
    eventTypes: ["app:install"],
  },
] as const satisfies readonly PlatformSource[];
