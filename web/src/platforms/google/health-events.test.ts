import { describe, expect, test } from "vitest";
import { dayHasGoogleHealthSleep, isDailyHealthMetric, isFitbitSleep } from "./health-events";

describe("dayHasGoogleHealthSleep", () => {
  test("detects google-health sleep and naps", () => {
    expect(dayHasGoogleHealthSleep([{ source: "google-health", type: "sleep" }])).toBe(true);
    expect(dayHasGoogleHealthSleep([{ source: "google-health", type: "sleep:nap" }])).toBe(true);
  });

  test("ignores fitbit sleep and unrelated sources", () => {
    expect(dayHasGoogleHealthSleep([{ source: "fitbit", type: "sleep" }])).toBe(false);
    expect(dayHasGoogleHealthSleep([{ source: "spotify", type: "listen:track" }])).toBe(false);
    expect(dayHasGoogleHealthSleep([])).toBe(false);
  });
});

describe("isFitbitSleep", () => {
  test("matches only fitbit sleep/nap", () => {
    expect(isFitbitSleep({ source: "fitbit", type: "sleep" })).toBe(true);
    expect(isFitbitSleep({ source: "fitbit", type: "sleep:nap" })).toBe(true);
  });

  test("does not match fitbit daily metrics or google-health sleep", () => {
    expect(isFitbitSleep({ source: "fitbit", type: "daily:hrv" })).toBe(false);
    expect(isFitbitSleep({ source: "google-health", type: "sleep" })).toBe(false);
  });
});

describe("timeline sleep de-dup decision", () => {
  test("fitbit sleep is hidden only when the day also has google-health sleep", () => {
    const dayWithBoth = [
      { source: "google-health", type: "sleep" },
      { source: "fitbit", type: "sleep" },
      { source: "fitbit", type: "sleep:nap" },
    ];
    const ghSleep = dayHasGoogleHealthSleep(dayWithBoth);
    // both fitbit entries suppressed, google-health kept
    expect(ghSleep && isFitbitSleep(dayWithBoth[1])).toBe(true);
    expect(ghSleep && isFitbitSleep(dayWithBoth[2])).toBe(true);
    expect(ghSleep && isFitbitSleep(dayWithBoth[0])).toBe(false);

    const fitbitOnly = [{ source: "fitbit", type: "sleep" }];
    expect(dayHasGoogleHealthSleep(fitbitOnly) && isFitbitSleep(fitbitOnly[0])).toBe(false);
  });
});

describe("isDailyHealthMetric", () => {
  test("matches daily metrics from both health sources", () => {
    expect(isDailyHealthMetric({ source: "fitbit", type: "daily:hrv" })).toBe(true);
    expect(isDailyHealthMetric({ source: "google-health", type: "daily:hrv" })).toBe(true);
    expect(isDailyHealthMetric({ source: "google-health", type: "daily:temperature" })).toBe(true);
  });

  test("keeps sleep and daily types the health panel does not show", () => {
    expect(isDailyHealthMetric({ source: "google-health", type: "sleep" })).toBe(false);
    expect(isDailyHealthMetric({ source: "fitbit", type: "daily:readiness" })).toBe(false);
  });
});
