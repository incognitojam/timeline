import type { PlatformMeta } from "../types";

export const swarmMeta = {
  id: "swarm",
  color: "#FFA633",
  sources: [
    {
      id: "swarm",
      label: "Swarm",
      // groupEvents also requires spatial proximity: time alone would merge train journeys.
      traits: { session: { gapMinutes: 15 } },
      eventTypes: ["location:visit"],
    },
  ],
} as const satisfies PlatformMeta;
