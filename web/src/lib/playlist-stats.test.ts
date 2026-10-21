import { describe, expect, it } from "vitest";
import {
  avgPerYear,
  countAsOf,
  creationAnchor,
  isoDaysBefore,
  pastYearSaves,
  trailingChange,
} from "./playlist-stats";

describe("isoDaysBefore", () => {
  it("shifts a date back by N days in UTC", () => {
    expect(isoDaysBefore("2026-06-02", 365)).toBe("2025-06-02");
    expect(isoDaysBefore("2026-03-01", 1)).toBe("2026-02-28");
  });
});

describe("countAsOf", () => {
  const series = [
    { date: "2025-02-14", count: 30 },
    { date: "2025-08-20", count: 34 },
    { date: "2026-05-28", count: 50 },
  ];

  it("returns the most recent reading on or before the date", () => {
    expect(countAsOf(series, "2025-08-20")).toBe(34);
    expect(countAsOf(series, "2026-01-01")).toBe(34);
  });

  it("clamps to the first reading for dates before the series", () => {
    expect(countAsOf(series, "2020-01-01")).toBe(30);
  });

  it("returns 0 for an empty series", () => {
    expect(countAsOf([], "2026-01-01")).toBe(0);
  });
});

describe("trailingChange", () => {
  it("returns null with fewer than two readings", () => {
    expect(trailingChange([], 365)).toBeNull();
    expect(trailingChange([{ date: "2026-05-28", count: 50 }], 365)).toBeNull();
  });

  it("measures against the most recent reading on or before the cutoff", () => {
    // A tracked playlist with a sparse seed history (no reading
    // between Feb and Aug 2025) plus flat daily live readings. The trailing
    // year reaches back to the 2025-02-14 reading (30), not the 2022 baseline,
    // so the figure is +20 rather than the lifetime +45.
    const series = [
      { date: "2022-03-10", count: 5 },
      { date: "2025-02-14", count: 30 },
      { date: "2025-08-20", count: 34 },
      { date: "2026-05-28", count: 50 },
      { date: "2026-06-02", count: 50 },
    ];
    expect(trailingChange(series, 365)).toBe(20);
  });

  it("collapses to the all-time change for a series shorter than the window", () => {
    const series = [
      { date: "2026-05-28", count: 42 },
      { date: "2026-06-02", count: 50 },
    ];
    expect(trailingChange(series, 365)).toBe(8);
  });
});

describe("creationAnchor", () => {
  const series = [
    { date: "2026-06-10", count: 1200 },
    { date: "2026-06-11", count: 1201 },
  ];

  it("returns a 0-saves point at the creation date when it predates the series", () => {
    expect(creationAnchor("2021-06-01", series)).toEqual({
      date: "2021-06-01",
      count: 0,
    });
  });

  it("returns null when the creation date is unknown", () => {
    expect(creationAnchor(null, series)).toBeNull();
    expect(creationAnchor(undefined, series)).toBeNull();
  });

  it("returns null when the creation date is on or after the first reading", () => {
    // A seed reading can predate the derived creation proxy; don't draw a
    // backwards or zero-length anchor segment in that case.
    expect(creationAnchor("2026-06-10", series)).toBeNull();
    expect(creationAnchor("2026-06-20", series)).toBeNull();
  });
});

describe("avgPerYear", () => {
  it("returns null with fewer than two points", () => {
    expect(avgPerYear([])).toBeNull();
    expect(avgPerYear([{ date: "2026-06-01", count: 100 }])).toBeNull();
  });

  it("returns null for a non-positive span", () => {
    expect(
      avgPerYear([
        { date: "2026-06-01", count: 10 },
        { date: "2026-06-01", count: 20 },
      ]),
    ).toBeNull();
  });

  it("annualizes growth across the full span", () => {
    // A creation anchor (0) five years before the latest reading: 9000 / 5yr.
    expect(
      avgPerYear([
        { date: "2021-06-01", count: 0 },
        { date: "2026-06-01", count: 9000 },
      ]),
    ).toBe(1800);
  });
});

describe("pastYearSaves", () => {
  it("returns the real trailing change when there are two or more readings", () => {
    const series = [
      { date: "2026-05-28", count: 42 },
      { date: "2026-06-02", count: 50 },
    ];
    expect(pastYearSaves(series, "2020-01-01")).toEqual({
      value: 8,
      estimated: false,
    });
  });

  it("returns null for a single reading with no known creation date", () => {
    expect(pastYearSaves([{ date: "2026-06-01", count: 500 }], null)).toBeNull();
  });

  it("estimates the full count for a playlist younger than a year", () => {
    // Created within the trailing year ⇒ every save was gained in it.
    expect(
      pastYearSaves([{ date: "2026-06-01", count: 300 }], "2026-01-01"),
    ).toEqual({ value: 300, estimated: true });
  });

  it("estimates the linear annual rate for an older playlist", () => {
    // Created two years before the only reading: 1000 / 2yr ≈ 500 per year.
    expect(
      pastYearSaves([{ date: "2026-06-01", count: 1000 }], "2024-06-01"),
    ).toEqual({ value: 500, estimated: true });
  });
});
