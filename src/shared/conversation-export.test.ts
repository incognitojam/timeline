import { describe, expect, test } from "bun:test";
import { parseConversationRangeExportFormat } from "./conversation-export";

describe("parseConversationRangeExportFormat", () => {
  test("accepts only the supported timestamp styles", () => {
    expect(parseConversationRangeExportFormat({ timestampStyle: "date-headers" }).timestampStyle)
      .toBe("date-headers");
    expect(parseConversationRangeExportFormat({ timestampStyle: "full-timestamps" }).timestampStyle)
      .toBe("full-timestamps");
    expect(() => parseConversationRangeExportFormat({ timestampStyle: "legacy-format" }))
      .toThrow("format.timestampStyle must be one of: date-headers, full-timestamps");
  });

  test("defaults compactAuthors to true and accepts an explicit false value", () => {
    expect(parseConversationRangeExportFormat(undefined).compactAuthors).toBe(true);
    expect(parseConversationRangeExportFormat({ compactAuthors: false }).compactAuthors).toBe(false);
    expect(() => parseConversationRangeExportFormat({ compactAuthors: "false" })).toThrow(
      "format.compactAuthors must be a boolean",
    );
  });

  test("defaults name anonymisation off and accepts only booleans", () => {
    expect(parseConversationRangeExportFormat(undefined).anonymiseNames).toBe(false);
    expect(parseConversationRangeExportFormat({ anonymiseNames: true }).anonymiseNames).toBe(true);
    expect(() => parseConversationRangeExportFormat({ anonymiseNames: "yes" })).toThrow(
      "format.anonymiseNames must be a boolean",
    );
  });

  test("canonicalizes accepted time zone casing", () => {
    const format = parseConversationRangeExportFormat({
      timeZone: "america/new_york",
    });

    expect(format.timeZone).toBe("America/New_York");
  });
});
