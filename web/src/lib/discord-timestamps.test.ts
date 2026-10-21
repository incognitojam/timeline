import { describe, expect, it } from "vitest";
import { formatDiscordTimestamp, formatDiscordTimestampTooltip } from "./discord-timestamps";

// 2023-06-13T19:00:00Z. Rendering is locale- and timezone-dependent by design
// (Discord renders in the reader's own), so assertions here check which
// components a style includes rather than one locale's exact punctuation.
const SECONDS = 1686682800;
const DATE = new Date(SECONDS * 1000);

const year = DATE.toLocaleString(undefined, { year: "numeric" });
const weekday = DATE.toLocaleString(undefined, { weekday: "long" });

describe("formatDiscordTimestamp", () => {
  it("renders time only for t and T, with seconds only for T", () => {
    const short = formatDiscordTimestamp(SECONDS, "t");
    const long = formatDiscordTimestamp(SECONDS, "T");
    expect(short).not.toContain(year);
    expect(long).not.toContain(year);
    expect(short.split(":")).toHaveLength(2);
    expect(long.split(":")).toHaveLength(3);
  });

  it("renders date only for d and D", () => {
    for (const style of ["d", "D"] as const) {
      const out = formatDiscordTimestamp(SECONDS, style);
      expect(out).toContain(year);
      expect(out).not.toContain(":");
    }
  });

  it("renders date and time for f, adding the weekday for F", () => {
    const short = formatDiscordTimestamp(SECONDS, "f");
    expect(short).toContain(year);
    expect(short).toContain(":");
    expect(short).not.toContain(weekday);

    const full = formatDiscordTimestamp(SECONDS, "F");
    expect(full).toContain(year);
    expect(full).toContain(":");
    expect(full).toContain(weekday);
  });

  it("renders R relative to the reading time, at the coarsest filled unit", () => {
    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    const now = new Date("2023-08-13T19:00:00Z");
    expect(formatDiscordTimestamp(SECONDS, "R", now)).toBe(relative.format(-2, "month"));
    expect(formatDiscordTimestamp(SECONDS, "R", new Date("2023-06-13T17:30:00Z"))).toBe(
      relative.format(2, "hour"),
    );
    expect(formatDiscordTimestamp(SECONDS, "R", new Date("2023-06-13T19:00:00Z"))).toBe(
      relative.format(0, "second"),
    );
  });
});

describe("formatDiscordTimestampTooltip", () => {
  it("always gives the full form, even for styles that drop the date", () => {
    expect(formatDiscordTimestampTooltip(SECONDS)).toBe(formatDiscordTimestamp(SECONDS, "F"));
  });
});
