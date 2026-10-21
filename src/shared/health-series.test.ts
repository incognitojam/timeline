import { describe, expect, test } from "bun:test";
import { summarizeHealthDailyValues } from "./health-series";

describe("health daily value contract", () => {
  test("a partial current week averages recorded days and leaves future days empty", () => {
    const summary = summarizeHealthDailyValues({
      range: { start: "2026-08-10", end: "2026-08-16" },
      completeThrough: "2026-08-12",
      entries: [
        { date: "2026-08-10", value: 2_058 },
        { date: "2026-08-11", value: 7_427 },
        { date: "2026-08-12", value: 355 },
      ],
      goal: 10_000,
    });

    expect(summary).toMatchObject({
      total: 9_840,
      average: 3_280,
      recordedDays: 3,
      missingDays: 0,
      futureDays: 4,
      goalMetDays: 0,
    });
    expect(summary.byDay.map((day) => day.state)).toEqual([
      "recorded",
      "recorded",
      "recorded",
      "future",
      "future",
      "future",
      "future",
    ]);
  });

  test("recorded zeroes count in averages while missing dates do not", () => {
    const summary = summarizeHealthDailyValues({
      range: { start: "2026-08-06", end: "2026-08-12" },
      completeThrough: "2026-08-12",
      entries: [
        { date: "2026-08-06", value: 10_000 },
        { date: "2026-08-07", value: 0 },
        { date: "2026-08-09", value: 5_000 },
      ],
      goal: 10_000,
    });

    expect(summary).toMatchObject({
      total: 15_000,
      average: 5_000,
      recordedDays: 3,
      missingDays: 4,
      futureDays: 0,
      goalMetDays: 1,
    });
    expect(summary.byDay[1]).toEqual({
      date: "2026-08-07",
      value: 0,
      state: "recorded",
    });
    expect(summary.byDay[2]).toEqual({
      date: "2026-08-08",
      value: null,
      state: "missing",
    });
  });

  test("an empty period reports no average rather than a fabricated zero", () => {
    const summary = summarizeHealthDailyValues({
      range: { start: "2026-08-10", end: "2026-08-12" },
      completeThrough: "2026-08-12",
      entries: [],
    });

    expect(summary.average).toBeNull();
    expect(summary.total).toBe(0);
    expect(summary.recordedDays).toBe(0);
    expect(summary.missingDays).toBe(3);
    expect(summary.goalMetDays).toBeNull();
  });

  test("rejects ambiguous or invalid recorded values", () => {
    expect(() => summarizeHealthDailyValues({
      range: { start: "2026-08-10", end: "2026-08-12" },
      completeThrough: "2026-08-12",
      entries: [
        { date: "2026-08-10", value: 1_000 },
        { date: "2026-08-10", value: 2_000 },
      ],
    })).toThrow("Duplicate health value");

    expect(() => summarizeHealthDailyValues({
      range: { start: "2026-08-10", end: "2026-08-12" },
      completeThrough: "2026-08-12",
      entries: [{ date: "2026-08-10", value: -1 }],
    })).toThrow("Invalid health value");
  });
});
