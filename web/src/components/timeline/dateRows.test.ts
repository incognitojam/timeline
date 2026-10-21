import { describe, expect, it } from "vitest";
import { buildActivityRows, findRowForDate, formatMonthLabel } from "./dateRows";

describe("buildActivityRows", () => {
  it("opens each month with a divider", () => {
    const rows = buildActivityRows([
      "2026-08-02",
      "2026-08-01",
      "2026-07-31",
    ]);

    expect(rows.map((row) => row.key)).toEqual([
      "month:2026-08",
      "2026-08-02",
      "2026-08-01",
      "month:2026-07",
      "2026-07-31",
    ]);
  });

  it("repeats a month divider when the same month recurs a year later", () => {
    const rows = buildActivityRows(["2026-08-02", "2025-08-02"]);

    expect(
      rows.filter((row) => row.kind === "month").map((row) => row.month),
    ).toEqual(["2026-08", "2025-08"]);
  });

  it("opens a month once however far apart its dates are", () => {
    const rows = buildActivityRows(["2026-08-30", "2026-08-04"]);

    expect(rows.map((row) => row.kind)).toEqual(["month", "date", "date"]);
  });

  it("returns no rows for an empty list", () => {
    expect(buildActivityRows([])).toEqual([]);
  });
});

describe("formatMonthLabel", () => {
  it("names the month and year", () => {
    expect(formatMonthLabel("2026-08")).toBe("August 2026");
    expect(formatMonthLabel("2026-01")).toBe("January 2026");
  });
});

describe("findRowForDate", () => {
  const rows = buildActivityRows(["2016-08-27", "2016-08-09", "2016-08-06", "2016-07-30"]);

  it("finds the selected date's own row", () => {
    const match = findRowForDate(rows, "2016-08-09");

    expect(match).toEqual({ index: rows.findIndex((row) => row.key === "2016-08-09"), exact: true });
  });

  it("falls back to the nearest earlier date when the day has no events", () => {
    const match = findRowForDate(rows, "2016-08-20");

    expect(match).toEqual({ index: rows.findIndex((row) => row.key === "2016-08-09"), exact: false });
  });

  it("waits while the date sits outside the loaded range", () => {
    expect(findRowForDate(rows, "2016-09-01")).toBeNull();
    expect(findRowForDate(rows, "2016-07-01")).toBeNull();
    expect(findRowForDate([], "2016-08-09")).toBeNull();
  });
});
