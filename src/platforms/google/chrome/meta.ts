import type { PlatformSource } from "../../types";

export const chromeSources = [
  {
    id: "chrome",
    label: "Chrome",
    traits: { session: { gapMinutes: 30 } },
    color: "#D99200",
    eventTypes: ["browse"],
  },
] as const satisfies readonly PlatformSource[];
