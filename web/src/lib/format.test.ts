import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IconArchive,
  IconAttachFile,
  IconAudioFile,
  IconDescription,
  IconDraft,
  IconImage,
  IconMovie,
  IconPictureAsPdf,
  IconSlideshow,
  IconTableChart,
} from "../ui/icons";
import { formatDateSeparator, formatRelativeDate, getFileIcon, getInitials, guildAcronym } from "./format";

describe("getFileIcon", () => {
  it("prefers MIME types when selecting media and PDF icons", () => {
    expect(getFileIcon("wrong.txt", "image/png")).toBe(IconImage);
    expect(getFileIcon(null, "video/mp4")).toBe(IconMovie);
    expect(getFileIcon(null, "audio/mpeg")).toBe(IconAudioFile);
    expect(getFileIcon(null, "application/pdf")).toBe(IconPictureAsPdf);
  });

  it("selects document icons from file extensions", () => {
    expect(getFileIcon("bundle.zip")).toBe(IconArchive);
    expect(getFileIcon("report.docx")).toBe(IconDescription);
    expect(getFileIcon("data.csv")).toBe(IconTableChart);
    expect(getFileIcon("slides.pptx")).toBe(IconSlideshow);
    expect(getFileIcon("notes.md")).toBe(IconDraft);
    expect(getFileIcon("unknown.bin")).toBe(IconAttachFile);
  });
});

describe("formatRelativeDate", () => {
  // Pin "now" so the day-granular thresholds are deterministic regardless of
  // when the suite runs. Arithmetic is on UTC instants, so it's TZ-independent.
  const NOW = "2024-06-15T12:00:00Z";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for null", () => {
    expect(formatRelativeDate(null)).toBe("");
  });

  it("treats same-day and future timestamps as today", () => {
    expect(formatRelativeDate("2024-06-15T08:00:00Z")).toBe("today");
    expect(formatRelativeDate("2024-06-20T08:00:00Z")).toBe("today");
  });

  it("labels one day ago as yesterday", () => {
    expect(formatRelativeDate("2024-06-14T12:00:00Z")).toBe("yesterday");
  });

  it("uses Nd ago between 2 and 29 days", () => {
    expect(formatRelativeDate("2024-06-12T12:00:00Z")).toBe("3d ago");
  });

  it("falls back to month/day within the year", () => {
    const iso = "2024-04-16T12:00:00Z"; // 60 days prior
    expect(formatRelativeDate(iso)).toBe(
      new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });

  it("falls back to month/year beyond a year", () => {
    const iso = "2023-05-11T12:00:00Z"; // ~400 days prior
    expect(formatRelativeDate(iso)).toBe(
      new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" }),
    );
  });
});

describe("formatDateSeparator", () => {
  it("formats strings and dates like conversation date dividers", () => {
    const timestamp = "2026-07-19T19:56:10Z";
    const expected = new Date(timestamp).toLocaleDateString([], {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    expect(formatDateSeparator(timestamp)).toBe(expected);
    expect(formatDateSeparator(new Date(timestamp))).toBe(expected);
  });

  it("returns an empty string without a timestamp", () => {
    expect(formatDateSeparator(null)).toBe("");
  });
});

describe("guildAcronym", () => {
  it("replaces each word with its first character", () => {
    expect(guildAcronym("My Cool Server")).toBe("MCS");
    expect(guildAcronym("Gaming")).toBe("G");
  });

  it("keeps hyphens and case and collapses a possessive 's (Discord parity)", () => {
    expect(guildAcronym("Example's Widget-o-matic")).toBe("EW-o-m");
    expect(guildAcronym("the-lounge")).toBe("t-l");
  });

  it("passes through non-word characters such as emoji", () => {
    expect(guildAcronym("🎮 Gaming")).toBe("🎮G");
  });

  it("returns the fallback when only whitespace remains", () => {
    expect(guildAcronym("")).toBe("#");
    expect(guildAcronym("   ")).toBe("#");
    expect(guildAcronym("", "·")).toBe("·");
  });
});

describe("getInitials", () => {
  it("uses first and last initials for multi-word names", () => {
    expect(getInitials("Alice Example")).toBe("AE");
    expect(getInitials("Alice Middle Example")).toBe("AE");
  });

  it("uses the first two characters of a single-word name", () => {
    expect(getInitials("Sample")).toBe("SA");
  });

  it("trims and collapses surrounding whitespace", () => {
    expect(getInitials("  Bob   Example  ")).toBe("BE");
  });

  it("returns empty string for an empty name", () => {
    expect(getInitials("")).toBe("");
  });
});
