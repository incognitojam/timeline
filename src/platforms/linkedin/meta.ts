import type { PlatformMeta } from "../types";

export const linkedinMeta = {
  id: "linkedin",
  color: "#0A66C2",
  sources: [
    {
      id: "linkedin",
      label: "LinkedIn",
      eventTypes: ["message", "connection", "job", "education"],
    },
  ],
  identityPlatforms: ["linkedin"],
} as const satisfies PlatformMeta;
