import type { PlatformMeta } from "../types";

export const t3codeMeta = {
  id: "t3code",
  color: "#8e51ff",
  sources: [
    {
      id: "t3code",
      label: "T3 Code",
      eventTypes: ["t3code:message:user", "t3code:message:assistant"],
    },
  ],
  identityPlatforms: ["t3code"],
} as const satisfies PlatformMeta;
