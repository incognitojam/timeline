import { describe, expect, test } from "bun:test";
import { clampLimit, clampOffset } from "./query-params";

describe("query parameter clamps", () => {
  test("clampLimit enforces fallback for missing, invalid, zero, and negative values", () => {
    expect(clampLimit(undefined, 50, 200)).toBe(50);
    expect(clampLimit("banana", 50, 200)).toBe(50);
    expect(clampLimit("0", 50, 200)).toBe(50);
    expect(clampLimit("-1", 50, 200)).toBe(50);
  });

  test("clampLimit caps huge positive values", () => {
    expect(clampLimit("99999", 50, 200)).toBe(200);
  });

  test("clampOffset never returns a negative or invalid value", () => {
    expect(clampOffset(undefined)).toBe(0);
    expect(clampOffset("banana")).toBe(0);
    expect(clampOffset("-1")).toBe(0);
    expect(clampOffset("25")).toBe(25);
  });
});
