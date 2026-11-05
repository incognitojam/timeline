import type { PlatformSource } from "../../types";

export const searchSources = [
  {
    id: "google-search",
    label: "Google Search",
    traits: { session: { gapMinutes: 15 } },
    color: "#4285F4",
    eventTypes: ["search"],
  },
] as const satisfies readonly PlatformSource[];
