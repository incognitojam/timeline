import { describe, expect, test } from "vitest";
import { withoutDuplicateHealthEvents } from "./health-events";

const event = (source: string, type: string) => ({ source, type });

describe("withoutDuplicateHealthEvents", () => {
  test.each([
    {
      name: "fitbit sleep and naps give way to google-health sleep",
      day: [event("google-health", "sleep"), event("fitbit", "sleep"), event("fitbit", "sleep:nap")],
      kept: [event("google-health", "sleep")],
    },
    {
      name: "a google-health nap is enough to drop fitbit sleep",
      day: [event("google-health", "sleep:nap"), event("fitbit", "sleep")],
      kept: [event("google-health", "sleep:nap")],
    },
    {
      name: "fitbit sleep stays when google-health has no sleep that day",
      day: [event("fitbit", "sleep"), event("fitbit", "sleep:nap"), event("google-health", "daily:hrv")],
      kept: [event("fitbit", "sleep"), event("fitbit", "sleep:nap")],
    },
    {
      name: "daily metrics from either source go to the health panel; other daily types stay",
      day: [
        event("fitbit", "daily:hrv"),
        event("google-health", "daily:temperature"),
        event("fitbit", "daily:readiness"),
        event("spotify", "listen:track"),
      ],
      kept: [event("fitbit", "daily:readiness"), event("spotify", "listen:track")],
    },
  ])("$name", ({ day, kept }) => {
    expect(withoutDuplicateHealthEvents(day)).toEqual(kept);
  });
});
