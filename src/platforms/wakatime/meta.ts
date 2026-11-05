import type { PlatformMeta } from "../types";

export const wakatimeMeta = {
  id: "wakatime",
  color: "#2595ff",
  sources: [
    {
      id: "wakatime",
      label: "WakaTime",
      eventTypes: ["code:session", "code:heartbeat"],
    },
  ],
} as const satisfies PlatformMeta;
