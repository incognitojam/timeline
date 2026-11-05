import type { PlatformMeta } from "../types";

export const thrivaMeta = {
  id: "thriva",
  color: "#9856c8",
  sources: [
    {
      id: "thriva",
      label: "Thriva",
      eventTypes: ["thriva:biomarker", "thriva:order"],
    },
  ],
} as const satisfies PlatformMeta;
