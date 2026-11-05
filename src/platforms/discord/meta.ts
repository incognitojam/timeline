import type { PlatformMeta } from "../types";

export const discordMeta = {
  id: "discord",
  color: "#5865F2",
  sources: [
    {
      id: "discord",
      label: "Discord",
      eventTypes: [
        "message:dm",
        "message:dm:attachment",
        "message:dm:call",
        "message:dm:forward",
        "message:dm:poll",
        "message:dm:sticker",
        "message:group",
        "message:group:attachment",
        "message:group:call",
        "message:group:forward",
        "message:group:poll",
        "message:group:sticker",
        "message:guild",
        "message:guild:attachment",
        "message:guild:call",
        "message:guild:forward",
        "message:guild:poll",
        "message:guild:sticker",
      ],
    },
  ],
  identityPlatforms: ["discord"],
} as const satisfies PlatformMeta;
