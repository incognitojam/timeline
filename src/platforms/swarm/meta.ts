import type { PlatformMeta } from "../types";

export const swarmMeta = {
  id: "swarm",
  color: "#FFA633",
  sources: [
    {
      id: "swarm",
      label: "Swarm",
      eventTypes: ["location:visit"],
    },
  ],
} as const satisfies PlatformMeta;
