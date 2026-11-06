import { describe, test, expect } from "bun:test";
import { parseFollowerCount } from "./seed-playlist-follows";

describe("parseFollowerCount", () => {
  test("parses plain integers", () => {
    expect(parseFollowerCount("69")).toBe(69);
    expect(parseFollowerCount(" 1234 ")).toBe(1234);
    expect(parseFollowerCount("0")).toBe(0);
  });

  test("tolerates thousands separators", () => {
    expect(parseFollowerCount("1,234")).toBe(1234);
    expect(parseFollowerCount("1_000")).toBe(1000);
    expect(parseFollowerCount("12 345")).toBe(12345);
    expect(parseFollowerCount("1,234,567")).toBe(1234567);
  });

  test("rejects malformed values instead of silently truncating", () => {
    // The bug this guards: Number.parseInt("1,234", 10) === 1
    expect(parseFollowerCount("")).toBeNull();
    expect(parseFollowerCount("abc")).toBeNull();
    expect(parseFollowerCount("12.5")).toBeNull();
    expect(parseFollowerCount("1,2,3.4")).toBeNull();
    expect(parseFollowerCount("-5")).toBeNull();
    expect(parseFollowerCount("12x")).toBeNull();
  });
});
