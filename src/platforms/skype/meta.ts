import type { PlatformMeta } from "../types";

export const skypeMeta = {
  id: "skype",
  color: "#00AFF0",
  sources: [
    {
      id: "skype",
      label: "Skype",
      eventTypes: [
        "message:dm",
        "message:dm:attachment",
        "message:group",
        "message:group:attachment",
        "message:call",
        "call:log",
      ],
    },
    {
      id: "live",
      label: "Microsoft Live",
    },
  ],
  identityPlatforms: ["skype", "live"],
} as const satisfies PlatformMeta;
