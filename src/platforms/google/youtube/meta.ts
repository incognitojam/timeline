import type { PlatformSource } from "../../types";

export const youtubeSources = [
  {
    id: "youtube",
    label: "YouTube",
    traits: { session: { gapMinutes: 15 } },
    color: "#FF0000",
    eventTypes: [
      "youtube:watch",
      "youtube:search",
      "youtube:like",
      "youtube:subscribe",
      "youtube:subscription",
      "youtube:view",
    ],
  },
] as const satisfies readonly PlatformSource[];
