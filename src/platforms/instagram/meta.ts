import type { PlatformMeta } from "../types";

export const instagramMeta = {
  id: "instagram",
  color: "#E4405F",
  sources: [
    {
      id: "instagram",
      label: "Instagram",
      traits: { conversation: "social", corpus: true },
      eventTypes: [
        "message:dm",
        "message:dm:attachment",
        "message:dm:audio",
        "message:dm:share",
        "message:dm:share:reel",
        "message:dm:sticker",
        "message:dm:unsent",
        "message:group",
        "message:group:attachment",
        "message:group:audio",
        "message:group:share",
        "message:group:share:reel",
        "message:group:sticker",
        "message:group:unsent",
      ],
    },
  ],
  identityPlatforms: ["instagram"],
} as const satisfies PlatformMeta;
