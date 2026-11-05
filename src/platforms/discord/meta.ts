import type { PlatformMeta } from "../types";

export const discordMeta = {
  id: "discord",
  color: "#5865F2",
  sources: [{ id: "discord", label: "Discord" }],
} as const satisfies PlatformMeta;
