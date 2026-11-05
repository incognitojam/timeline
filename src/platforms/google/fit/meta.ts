import type { PlatformSource } from "../../types";

export const fitSources = [
  {
    id: "google-fit",
    label: "Google Fit",
    color: "#4285F4",
    eventTypes: ["activity:*"],
  },
] as const satisfies readonly PlatformSource[];
