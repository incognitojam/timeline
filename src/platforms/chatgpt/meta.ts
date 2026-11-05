import type { PlatformMeta } from "../types";

export const chatgptMeta = {
  id: "chatgpt",
  color: "#10A37F",
  sources: [
    {
      id: "chatgpt",
      label: "ChatGPT",
      traits: { conversation: "chat-assistant", corpus: true },
      eventTypes: ["chatgpt:message:user", "chatgpt:message:assistant"],
    },
  ],
  identityPlatforms: ["chatgpt"],
} as const satisfies PlatformMeta;
