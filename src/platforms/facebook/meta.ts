import type { PlatformMeta } from "../types";

export const facebookMeta = {
  id: "facebook",
  color: "#1877F2",
  sources: [
    {
      id: "facebook",
      label: "Facebook",
      eventTypes: [
        "message",
        "message:audio",
        "message:call",
        "message:gif",
        "message:photo",
        "message:poll",
        "message:share",
        "message:sticker",
        "message:unsent",
        "message:video",
        "post",
        "post:page",
        "comment",
        "reaction:*",
        "group:post",
        "group:comment",
        "group:join",
        "event:invitation",
        "event:response",
        "friend:added",
        "friend:removed",
        "poke",
      ],
    },
  ],
  identityPlatforms: ["facebook"],
} as const satisfies PlatformMeta;
