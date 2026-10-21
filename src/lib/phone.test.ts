import { describe, expect, it } from "bun:test";
import { normalizePhoneNumber } from "./phone";

describe("normalizePhoneNumber", () => {
  it("preserves international numbers", () => {
    expect(normalizePhoneNumber("+447700900123")).toBe("+447700900123");
  });

  it("strips spaces, parens, and dashes", () => {
    expect(normalizePhoneNumber("+44 (7700) 900-123")).toBe("+447700900123");
  });

  it("normalizes UK national format to +44", () => {
    expect(normalizePhoneNumber("07700900123")).toBe("+447700900123");
  });

  it("preserves alphanumeric sender IDs (e.g. SMS shortcodes)", () => {
    expect(normalizePhoneNumber("ExampleSender")).toBe("ExampleSender");
    expect(normalizePhoneNumber("ExampleCo")).toBe("ExampleCo");
    expect(normalizePhoneNumber("ExampleShop")).toBe("ExampleShop");
  });

  it("trims whitespace on alphanumeric sender IDs", () => {
    expect(normalizePhoneNumber("  ExampleShop  ")).toBe("ExampleShop");
  });

  it("returns empty for empty input", () => {
    expect(normalizePhoneNumber("")).toBe("");
    expect(normalizePhoneNumber("   ")).toBe("");
  });

  it("preserves numeric short codes", () => {
    expect(normalizePhoneNumber("62884")).toBe("62884");
  });
});
