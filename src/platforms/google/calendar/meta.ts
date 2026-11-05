import type { PlatformSource } from "../../types";

export const calendarSources = [
  {
    id: "google-calendar",
    label: "Google Calendar",
    traits: { personal: true, corpus: true },
    color: "#4285F4",
    eventTypes: ["event", "event:all-day"],
  },
] as const satisfies readonly PlatformSource[];
