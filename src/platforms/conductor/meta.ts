import type { PlatformMeta } from "../types";

export const conductorMeta = {
  id: "conductor",
  color: "#a4847f",
  sources: [
    {
      id: "conductor",
      label: "Conductor",
      traits: { conversation: "coding-agent", noisy: true, aiUsage: true, corpus: true },
      eventTypes: ["conductor:message:user", "conductor:message:assistant"],
    },
  ],
  identityPlatforms: ["conductor"],
} as const satisfies PlatformMeta;
