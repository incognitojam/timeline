import type { PlatformMeta } from "../types";

export const recallMeta = {
  id: "recall",
  color: "#7c8aa3",
  sources: [
    {
      id: "recall",
      label: "Recall",
      // Captures land every 30s, so anything within 5 minutes is one session; larger gaps
      // would merge separate work sessions. Hidden by default because they bury everything else.
      traits: { session: { gapMinutes: 5 }, noisy: true, defaultHidden: true },
      eventTypes: ["screen:capture"],
    },
  ],
} as const satisfies PlatformMeta;
