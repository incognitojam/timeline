import type { PlatformMeta } from "../types";

export const claudeMeta = {
  id: "claude",
  color: "#D97757",
  sources: [
    {
      id: "claude",
      label: "Claude",
      eventTypes: ["claude:message:user", "claude:message:assistant", "claude:memory"],
    },
  ],
  identityPlatforms: ["claude"],
} as const satisfies PlatformMeta;
