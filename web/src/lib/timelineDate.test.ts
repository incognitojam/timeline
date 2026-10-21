import { describe, it, expect } from "vitest";
import { getToday, resolveTimelineDate } from "./timelineDate";

describe("resolveTimelineDate", () => {
  it("returns the param when it's a valid YYYY-MM-DD", () => {
    expect(resolveTimelineDate("2026-01-15")).toBe("2026-01-15");
  });

  it("uses the first element when given an array", () => {
    expect(resolveTimelineDate(["2026-01-15", "2026-02-20"])).toBe("2026-01-15");
  });

  it.each([null, undefined, "", "garbage", "2026-1-1", "2026/01/15"])(
    "falls back to today for invalid input %p",
    (input) => {
      expect(resolveTimelineDate(input)).toBe(getToday());
    },
  );
});
