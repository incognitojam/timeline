import type { PlatformMeta } from "../types";

export const googleMessagesMeta = {
  id: "google-messages",
  color: "#1A73E8",
  sources: [
    {
      id: "google-messages",
      label: "Google Messages",
      eventTypes: [
        "sms:sent",
        "sms:received",
        "mms:sent",
        "mms:received",
        "rcs:sent",
        "rcs:received",
      ],
    },
  ],
} as const satisfies PlatformMeta;
