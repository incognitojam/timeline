import type { PlatformMeta } from "../types";

export const steamMeta = {
  id: "steam",
  color: "#66c0f4",
  sources: [
    {
      id: "steam",
      label: "Steam",
      eventTypes: ["steam:achievement", "steam:game:added", "steam:session"],
    },
    {
      id: "steam-friends",
      label: "Steam Friends",
      legacyEventTypes: ["steam:achievement:friend", "steam:session:friend"],
    },
  ],
  identityPlatforms: ["steam"],
} as const satisfies PlatformMeta;
