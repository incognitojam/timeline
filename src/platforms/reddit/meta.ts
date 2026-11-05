import type { PlatformMeta } from "../types";

export const redditMeta = {
  id: "reddit",
  color: "#FF4500",
  sources: [
    {
      id: "reddit",
      label: "Reddit",
      traits: { corpus: { excludedTypes: ["vote:up", "vote:down"] } },
      eventTypes: [
        "post",
        "comment",
        "message",
        "vote:up",
        "vote:down",
        "save",
      ],
    },
  ],
  identityPlatforms: ["reddit"],
} as const satisfies PlatformMeta;
