import type { PlatformMeta } from "../types";

export const jellyfinMeta = {
  id: "jellyfin",
  color: "#7762C5",
  sources: [
    {
      id: "jellyfin",
      label: "Jellyfin",
      traits: { session: { gapMinutes: 30 } },
      eventTypes: ["jellyfin:movie", "jellyfin:episode"],
    },
  ],
} as const satisfies PlatformMeta;
