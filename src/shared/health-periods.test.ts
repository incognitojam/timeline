import { describe, expect, test } from "bun:test";
import {
  canShiftHealthWindowForward,
  parseHealthWindow,
  resolveHealthWindow,
  shiftHealthWindow,
} from "./health-periods";

const ANCHOR = "2026-08-12";

describe("health window contract", () => {
  test("recent windows end at the anchor and use the expected chart resolution", () => {
    expect(resolveHealthWindow({ view: "day", mode: "recent", anchor: ANCHOR })).toMatchObject({
      range: { start: "2026-08-12", end: "2026-08-12" },
      bucket: "hour",
    });
    expect(resolveHealthWindow({ view: "week", mode: "recent", anchor: ANCHOR })).toMatchObject({
      range: { start: "2026-08-06", end: "2026-08-12" },
      bucket: "day",
    });
    expect(resolveHealthWindow({ view: "month", mode: "recent", anchor: ANCHOR })).toMatchObject({
      range: { start: "2026-07-14", end: "2026-08-12" },
      bucket: "day",
    });
    expect(resolveHealthWindow({ view: "quarter", mode: "recent", anchor: ANCHOR })).toMatchObject({
      range: { start: "2026-05-18", end: "2026-08-12" },
      bucket: "week",
    });
    expect(resolveHealthWindow({ view: "year", mode: "recent", anchor: ANCHOR })).toMatchObject({
      range: { start: "2025-09-01", end: "2026-08-12" },
      bucket: "month",
    });
  });

  test("calendar windows align after period navigation", () => {
    expect(resolveHealthWindow({ view: "day", mode: "calendar", anchor: ANCHOR })).toMatchObject({
      anchor: "2026-08-12",
      range: { start: "2026-08-12", end: "2026-08-12" },
    });
    expect(resolveHealthWindow({ view: "week", mode: "calendar", anchor: ANCHOR })).toMatchObject({
      anchor: "2026-08-10",
      range: { start: "2026-08-10", end: "2026-08-16" },
    });
    expect(resolveHealthWindow({ view: "month", mode: "calendar", anchor: ANCHOR })).toMatchObject({
      anchor: "2026-08-01",
      range: { start: "2026-08-01", end: "2026-08-31" },
    });
    expect(resolveHealthWindow({ view: "quarter", mode: "calendar", anchor: ANCHOR })).toMatchObject({
      anchor: "2026-07-01",
      range: { start: "2026-07-01", end: "2026-09-30" },
    });
    expect(resolveHealthWindow({ view: "year", mode: "calendar", anchor: ANCHOR })).toMatchObject({
      anchor: "2026-01-01",
      range: { start: "2026-01-01", end: "2026-12-31" },
    });
  });

  test("parses only complete canonical window parameters", () => {
    expect(parseHealthWindow({ view: "month", mode: "recent", anchor: ANCHOR })).toMatchObject({
      view: "month",
      mode: "recent",
      anchor: ANCHOR,
      range: { start: "2026-07-14", end: ANCHOR },
    });
    expect(parseHealthWindow({ view: "month", mode: "recent" })).toBeNull();
    expect(parseHealthWindow({ view: "three-months", mode: "recent", anchor: ANCHOR })).toBeNull();
    expect(parseHealthWindow({ view: "month", mode: "rolling", anchor: ANCHOR })).toBeNull();
    expect(parseHealthWindow({ view: "month", mode: "recent", anchor: "2026-02-30" })).toBeNull();
  });

  test("moves from recent into aligned calendar periods", () => {
    const recentWeek = resolveHealthWindow({ view: "week", mode: "recent", anchor: ANCHOR });
    const recentMonth = resolveHealthWindow({ view: "month", mode: "recent", anchor: ANCHOR });
    const recentQuarter = resolveHealthWindow({ view: "quarter", mode: "recent", anchor: ANCHOR });
    const recentYear = resolveHealthWindow({ view: "year", mode: "recent", anchor: ANCHOR });

    expect(shiftHealthWindow(recentWeek, -1).range).toEqual({
      start: "2026-08-03",
      end: "2026-08-09",
    });
    expect(shiftHealthWindow(recentMonth, -1).range).toEqual({
      start: "2026-07-01",
      end: "2026-07-31",
    });
    expect(shiftHealthWindow(recentQuarter, -1).range).toEqual({
      start: "2026-04-01",
      end: "2026-06-30",
    });
    expect(shiftHealthWindow(recentYear, -1).range).toEqual({
      start: "2025-01-01",
      end: "2025-12-31",
    });
  });

  test("forward navigation aligns recent windows to the current calendar period", () => {
    const july = resolveHealthWindow({
      view: "month",
      mode: "calendar",
      anchor: "2026-07-01",
    });
    const august = shiftHealthWindow(july, 1);
    const recentMonth = resolveHealthWindow({ view: "month", mode: "recent", anchor: ANCHOR });
    const recentYear = resolveHealthWindow({ view: "year", mode: "recent", anchor: ANCHOR });

    expect(august).toMatchObject({
      mode: "calendar",
      anchor: "2026-08-01",
      range: { start: "2026-08-01", end: "2026-08-31" },
    });
    expect(canShiftHealthWindowForward(july, ANCHOR)).toBe(true);
    expect(canShiftHealthWindowForward(august, ANCHOR)).toBe(false);
    expect(canShiftHealthWindowForward(recentMonth, ANCHOR)).toBe(true);
    expect(shiftHealthWindow(recentMonth, 1)).toMatchObject({
      mode: "calendar",
      anchor: "2026-08-01",
      range: { start: "2026-08-01", end: "2026-08-31" },
    });
    expect(canShiftHealthWindowForward(recentYear, ANCHOR)).toBe(true);
    expect(shiftHealthWindow(recentYear, 1)).toMatchObject({
      mode: "calendar",
      anchor: "2026-01-01",
      range: { start: "2026-01-01", end: "2026-12-31" },
    });
  });

  test("rejects invalid calendar dates instead of normalizing them", () => {
    expect(() => resolveHealthWindow({ view: "day", mode: "recent", anchor: "2026-02-30" })).toThrow(
      "Invalid health date",
    );
    expect(parseHealthWindow({ view: "year", mode: "calendar", anchor: "0000-01-01" })).toBeNull();
    expect(parseHealthWindow({ view: "month", mode: "calendar", anchor: "0099-12-01" })).toBeNull();
  });
});
