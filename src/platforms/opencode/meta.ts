import type { PlatformMeta } from "../types";

export const opencodeMeta = {
  id: "opencode",
  color: "#9ca3af",
  sources: [
    {
      id: "opencode",
      label: "OpenCode",
      eventTypes: ["opencode:message:user", "opencode:message:assistant"],
    },
  ],
  identityPlatforms: ["opencode"],
} as const satisfies PlatformMeta;
