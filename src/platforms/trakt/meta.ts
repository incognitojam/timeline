import type { PlatformMeta } from "../types";

export const traktMeta = {
  id: "trakt",
  color: "#ED1C24",
  sources: [
    {
      id: "trakt",
      label: "Trakt",
      traits: { session: { gapMinutes: 30 } },
      eventTypes: ["trakt:movie", "trakt:episode"],
    },
  ],
} as const satisfies PlatformMeta;
