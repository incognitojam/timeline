import type { PlatformMeta } from "../types";

export const codexMeta = {
  id: "codex",
  color: "#74c69d",
  sources: [
    {
      id: "codex",
      label: "Codex",
      eventTypes: ["codex:message:user", "codex:message:assistant"],
    },
  ],
  identityPlatforms: ["codex"],
} as const satisfies PlatformMeta;
