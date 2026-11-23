import type { PlatformMeta } from "../types";

export const callRecordingsMeta = {
  id: "call-recordings",
  color: "#f43f5e",
  sources: [
    {
      id: "call-recordings",
      label: "Call recordings",
      traits: { personal: true, corpus: true },
      eventTypes: ["recording:unknown"],
      legacyEventTypes: ["recording:incoming", "recording:outgoing"],
    },
  ],
} as const satisfies PlatformMeta;
