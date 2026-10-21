import { describe, expect, test } from "bun:test";
import { timeToHours, averageSleepTime } from "./health";

describe("timeToHours", () => {
  test("parses midnight", () => {
    expect(timeToHours("2025-01-15T00:00:00.000+00:00")).toBe(0);
  });

  test("parses morning time", () => {
    expect(timeToHours("2025-01-15T07:30:00.000+00:00")).toBe(7.5);
  });

  test("parses evening time", () => {
    expect(timeToHours("2025-01-15T22:45:00.000+00:00")).toBe(22.75);
  });

  test("preserves wall clock time regardless of timezone offset", () => {
    // Different offsets, same wall clock time — should all return 22.5
    expect(timeToHours("2025-01-15T22:30:00.000+00:00")).toBe(22.5);
    expect(timeToHours("2025-01-15T22:30:00.000+05:30")).toBe(22.5);
    expect(timeToHours("2025-01-15T22:30:00.000-08:00")).toBe(22.5);
  });
});

describe("averageSleepTime", () => {
  test("returns null for empty array", () => {
    expect(averageSleepTime([])).toBeNull();
  });

  test("returns exact time for single timestamp", () => {
    const result = averageSleepTime(["2025-01-15T23:00:00.000+00:00"]);
    expect(result).toBeCloseTo(23, 5);
  });

  test("averages times on same side of midnight", () => {
    // 22:00 and 23:00 → 22:30
    const result = averageSleepTime([
      "2025-01-15T22:00:00.000+00:00",
      "2025-01-15T23:00:00.000+00:00",
    ]);
    expect(result).toBeCloseTo(22.5, 1);
  });

  test("handles midnight crossover correctly", () => {
    // 23:00 and 01:00 should average to 00:00, not 12:00
    const result = averageSleepTime([
      "2025-01-15T23:00:00.000+00:00",
      "2025-01-16T01:00:00.000+00:00",
    ]);
    expect(result).toBeCloseTo(0, 1);
  });

  test("handles bedtimes clustering around midnight", () => {
    // 23:30, 00:00, 00:30 should average to ~00:00
    const result = averageSleepTime([
      "2025-01-15T23:30:00.000+00:00",
      "2025-01-16T00:00:00.000+00:00",
      "2025-01-16T00:30:00.000+00:00",
    ]);
    expect(result).toBeCloseTo(0, 1);
  });

  test("averages morning wake times", () => {
    // 06:00, 07:00, 08:00 → 07:00
    const result = averageSleepTime([
      "2025-01-15T06:00:00.000+00:00",
      "2025-01-15T07:00:00.000+00:00",
      "2025-01-15T08:00:00.000+00:00",
    ]);
    expect(result).toBeCloseTo(7, 1);
  });
});
