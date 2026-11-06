import type { PlatformSource } from "../../types";

export const placesSources = [
  {
    id: "google-places",
    label: "Google Places",
    color: "#34A853",
  },
] as const satisfies readonly PlatformSource[];
