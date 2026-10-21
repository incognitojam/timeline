import { describe, expect, it } from "vitest";
import { isSleepEvent, parseSleepEvent } from "./sleep";
import type { TimelineEvent } from "./types";

function makeEvent(raw: unknown, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 1,
    source: "google-health",
    source_id: "sleep:1",
    source_account: "user",
    type: "sleep",
    timestamp: "2026-01-14T23:00:00Z",
    end_timestamp: "2026-01-15T07:00:00Z",
    duration_ms: 28_800_000,
    title: "Sleep: 8h (94% efficiency)",
    content: "Deep: 120m, Light: 240m\nTime in bed: 480m",
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: JSON.stringify(raw),
    imported_at: "2026-01-15T08:00:00.000Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

// Shape of the google-health API payload the parser preserves in raw_data.
const googleHealthRaw = {
  name: "users/1/dataTypes/sleep/dataPoints/2",
  sleep: {
    interval: { startTime: "2026-01-14T23:00:00Z", endTime: "2026-01-15T07:00:00Z" },
    type: "STAGES",
    summary: {
      minutesInSleepPeriod: "480",
      minutesAsleep: "450",
      minutesAwake: "30",
      stagesSummary: [
        { type: "AWAKE", minutes: "30", count: "4" },
        { type: "LIGHT", minutes: "240", count: "12" },
        { type: "DEEP", minutes: "120", count: "5" },
        { type: "REM", minutes: "90", count: "5" },
      ],
    },
  },
};

describe("isSleepEvent", () => {
  it("matches google-health sleep and naps", () => {
    expect(isSleepEvent({ source: "google-health", type: "sleep" })).toBe(true);
    expect(isSleepEvent({ source: "google-health", type: "sleep:nap" })).toBe(true);
  });

  it("ignores fitbit sleep and other google-health metrics", () => {
    expect(isSleepEvent({ source: "fitbit", type: "sleep" })).toBe(false);
    expect(isSleepEvent({ source: "fitbit", type: "sleep:nap" })).toBe(false);
    expect(isSleepEvent({ source: "google-health", type: "daily:hrv" })).toBe(false);
  });
});

describe("parseSleepEvent", () => {
  it("reads stage totals in display order", () => {
    expect(parseSleepEvent(makeEvent(googleHealthRaw)).stageTotals).toEqual([
      { stage: "awake", durationMs: 30 * 60_000 },
      { stage: "rem", durationMs: 90 * 60_000 },
      { stage: "light", durationMs: 240 * 60_000 },
      { stage: "deep", durationMs: 120 * 60_000 },
    ]);
  });

  it("derives efficiency from time asleep over the sleep period", () => {
    const details = parseSleepEvent(makeEvent(googleHealthRaw));
    expect(details.asleepMs).toBe(450 * 60_000);
    expect(details.inBedMs).toBe(480 * 60_000);
    expect(details.efficiency).toBe(94);
  });

  it("skips stages reported with an unknown type or no minutes", () => {
    const raw = {
      sleep: {
        summary: {
          stagesSummary: [
            { type: "UNKNOWN", minutes: "30" },
            { type: "LIGHT", minutes: "0" },
            { type: "DEEP" },
            { type: "REM", minutes: "90" },
          ],
        },
      },
    };
    expect(parseSleepEvent(makeEvent(raw)).stageTotals).toEqual([
      { stage: "rem", durationMs: 90 * 60_000 },
    ]);
  });

  it("returns nothing for unparseable, unrelated or summary-less payloads", () => {
    const summaryless = { sleep: { interval: googleHealthRaw.sleep.interval } };
    for (const raw of ["not json", "{}", '{"levels":{}}', JSON.stringify(summaryless)]) {
      const details = parseSleepEvent(makeEvent({}, { raw_data: raw }));
      expect(details.stageTotals).toEqual([]);
      expect(details.asleepMs).toBeNull();
      expect(details.efficiency).toBeNull();
    }
  });
});
