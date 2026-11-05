import type { PlatformSource } from "../../types";

export const chatSources = [
  {
    id: "google-chat",
    label: "Google Chat",
    traits: { conversation: "social", corpus: true },
    color: "#00AC47",
    eventTypes: ["message"],
  },
] as const satisfies readonly PlatformSource[];
