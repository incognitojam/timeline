import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHealthWindow } from "@shared/health-periods";
import {
  formatComparison,
  formatSleepDurationComparison,
  getPeriodDateRange,
  getPeriodTitle,
  parseUrlPeriod,
} from "./HealthDashboard";

describe("health dashboard period title", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats the selected ISO week without using fetched stats", () => {
    const range = getPeriodDateRange(resolveHealthWindow({
      view: "week",
      mode: "calendar",
      anchor: "2026-07-01",
    }));

    expect(range).toEqual({ start: "2026-06-29", end: "2026-07-05" });
    expect(getPeriodTitle("week", "calendar", range.start, range.end, "en-GB")).toBe(
      "29 Jun - 5 Jul",
    );
  });

  it("formats date-only month ranges as calendar dates", () => {
    const range = getPeriodDateRange(resolveHealthWindow({
      view: "month",
      mode: "calendar",
      anchor: "2026-07-01",
    }));

    expect(range).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(getPeriodTitle("month", "calendar", range.start, range.end, "en-GB")).toBe("July");
  });

  it("shows the full range for a recent month", () => {
    const period = parseUrlPeriod({
      view: "month",
      mode: "recent",
      anchor: "2026-07-02",
    });

    expect(period.range).toEqual({ start: "2026-06-03", end: "2026-07-02" });
    expect(getPeriodTitle("month", period.mode, period.range.start, period.range.end, "en-GB"))
      .toBe("3 Jun - 2 Jul");
  });

  it("falls back instead of crashing on an invalid canonical window", () => {
    expect(parseUrlPeriod({
      view: "month",
      mode: "calendar",
      anchor: "2026-02-30",
    })).toMatchObject({
      view: "month",
      mode: "recent",
      anchor: "2026-07-02",
      range: { start: "2026-06-03", end: "2026-07-02" },
    });
  });
});

describe("health dashboard comparison copy", () => {
  it("describes recent-window comparisons as the previous period", () => {
    expect(formatComparison(6_412, 5_000, "period", {
      formatter: n => String(Math.round(n)),
    })).toBe("1412 higher than the previous period");
    expect(formatSleepDurationComparison(8 * 60 * 60_000, 7.5 * 60 * 60_000, "period"))
      .toBe("30 min more than the previous period");
  });

  it("names the previous calendar unit for calendar windows", () => {
    expect(formatComparison(6_412, 5_000, "year", {
      formatter: n => String(Math.round(n)),
    })).toBe("1412 higher than the previous year");
  });
});
