import type { PlatformSource } from "../../types";

export const keepSources = [
  {
    id: "google-keep",
    label: "Google Keep",
    traits: { corpus: true },
    color: "#E37400",
    eventTypes: ["note:text", "note:list"],
  },
] as const satisfies readonly PlatformSource[];
