import type { PlatformSource } from "../../types";

export const chromeSources = [
  {
    id: "chrome",
    label: "Chrome",
    color: "#D99200",
    eventTypes: ["browse"],
  },
] as const satisfies readonly PlatformSource[];
