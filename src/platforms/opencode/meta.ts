import type { PlatformMeta } from "../types";

export const opencodeMeta = {
  id: "opencode",
  color: "#9ca3af",
  sources: [
    {
      id: "opencode",
      label: "OpenCode",
      traits: { conversation: "coding-agent", noisy: true, aiUsage: true, corpus: true },
      eventTypes: ["opencode:message:user", "opencode:message:assistant"],
    },
  ],
  identityPlatforms: ["opencode"],
} as const satisfies PlatformMeta;
