import type { PlatformMeta } from "../types";

export const googleMessagesMeta = {
  id: "google-messages",
  color: "#1A73E8",
  sources: [{ id: "google-messages", label: "Google Messages" }],
} as const satisfies PlatformMeta;
