import type { PlatformMeta } from "../types";

export const traktMeta = {
  id: "trakt",
  color: "#ED1C24",
  sources: [
    {
      id: "trakt",
      label: "Trakt",
      eventTypes: ["trakt:movie", "trakt:episode"],
    },
  ],
} as const satisfies PlatformMeta;
