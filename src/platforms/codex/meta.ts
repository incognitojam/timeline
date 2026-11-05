import type { PlatformMeta } from "../types";

export const codexMeta = {
  id: "codex",
  color: "#74c69d",
  sources: [
    {
      id: "codex",
      label: "Codex",
      traits: { conversation: "coding-agent", noisy: true, aiUsage: true, corpus: true },
      eventTypes: ["codex:message:user", "codex:message:assistant"],
    },
  ],
  identityPlatforms: ["codex"],
} as const satisfies PlatformMeta;
