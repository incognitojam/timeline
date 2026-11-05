import type { PlatformSource } from "../../types";

export const chatSources = [
  {
    id: "google-chat",
    label: "Google Chat",
    color: "#00AC47",
    eventTypes: ["message"],
  },
] as const satisfies readonly PlatformSource[];
