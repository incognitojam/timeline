import type { PlatformMeta } from "../types";

export const recallMeta = {
  id: "recall",
  color: "#7c8aa3",
  sources: [
    {
      id: "recall",
      label: "Recall",
      eventTypes: ["screen:capture"],
    },
  ],
} as const satisfies PlatformMeta;
