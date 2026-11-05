import type { PlatformSource } from "../../types";

export const searchSources = [
  {
    id: "google-search",
    label: "Google Search",
    color: "#4285F4",
    eventTypes: ["search"],
  },
] as const satisfies readonly PlatformSource[];
