import type { PlatformMeta } from "../types";

export const facebookMeta = {
  id: "facebook",
  color: "#1877F2",
  sources: [
    {
      id: "facebook",
      label: "Facebook",
      // Reactions come in scroll-and-like bursts, so only they group by time;
      // messages group as conversations.
      traits: { conversation: "social", session: { gapMinutes: 15, reactionsOnly: true }, corpus: true },
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
