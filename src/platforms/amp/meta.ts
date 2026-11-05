import type { PlatformMeta } from "../types";

export const ampMeta = {
  id: "amp",
  color: "#f87171",
  sources: [
    {
      id: "amp",
      label: "Amp",
      traits: { conversation: "coding-agent", noisy: true, aiUsage: true, corpus: true },
      eventTypes: ["amp:message:user", "amp:message:assistant"],
    },
  ],
  identityPlatforms: ["amp"],
} as const satisfies PlatformMeta;
