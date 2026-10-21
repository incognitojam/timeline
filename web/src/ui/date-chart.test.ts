import { describe, expect, it } from "vitest";
import { dateChartLabels } from "./date-chart";

describe("date chart labels", () => {
  it("labels each day and the starting month, including a boundary after a missing day", () => {
    expect(dateChartLabels(["2025-08-30", "2025-08-31", "2025-09-02", "2025-09-03"], "month", "en-US"))
      .toEqual(["30\nAug", "31", "2\nSep", "3"]);
  });

  it("includes weekdays and dates in a week crossing a year boundary", () => {
    expect(dateChartLabels(["2025-12-31", "2026-01-01", "2026-01-02"], "week", "en-US"))
      .toEqual(["Wed\n31\nDec", "Thu\n1\nJan\n2026", "Fri\n2"]);
  });

  it("retains leap day and annotates consecutive month changes", () => {
    expect(dateChartLabels(["2024-02-29", "2024-03-01"], "month", "en-US"))
      .toEqual(["29\nFeb", "1\nMar"]);
  });

  it("labels monthly buckets and year changes even when January is missing", () => {
    expect(dateChartLabels(["2025-12-15", "2026-02-15", "2026-03-15"], "year", "en-GB"))
      .toEqual(["Dec", "Feb\n2026", "Mar"]);
    expect(dateChartLabels(["2026-01-15"], "year", "en-GB")).toEqual(["Jan"]);
  });
});
