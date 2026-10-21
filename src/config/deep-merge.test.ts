import { describe, expect, test } from "bun:test";
import { deepMerge } from "./deep-merge";

describe("deepMerge", () => {
  test("overrides primitive values", () => {
    const target = { a: 1, b: "x", c: true };
    const source = { a: 2, b: "y" };

    expect(deepMerge(target, source)).toEqual({ a: 2, b: "y", c: true });
  });

  test("does not override with undefined", () => {
    const target = { a: 1, b: "x" };
    const source: Partial<typeof target> = { a: undefined };

    expect(deepMerge(target, source)).toEqual({ a: 1, b: "x" });
  });

  test("deep merges nested objects", () => {
    const target = { nested: { a: 1, b: 2 }, other: 123 };
    const source = { nested: { b: 99 } };

    expect(deepMerge(target, source)).toEqual({ nested: { a: 1, b: 99 }, other: 123 });
  });

  test("adds keys that exist only in source", () => {
    expect(deepMerge({ a: 1 } as { a: number; b?: number }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("does not mutate target (including nested objects)", () => {
    const target = { nested: { a: 1, b: 2 } };
    const targetNestedBefore = target.nested;

    const merged = deepMerge(target, { nested: { b: 99 } });

    expect(target).toEqual({ nested: { a: 1, b: 2 } });
    expect(merged).toEqual({ nested: { a: 1, b: 99 } });
    expect(merged.nested).not.toBe(targetNestedBefore);
  });

  test("treats arrays as replaceable values (no deep merge)", () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4] };

    expect(deepMerge(target, source)).toEqual({ items: [4] });
  });

  test("treats null as a replaceable value (no deep merge)", () => {
    const target = { nested: { a: 1 }, other: 2 };
    const source = { nested: null };

    const result = deepMerge(target, source);
    expect(result.nested).toBeNull();
    expect(result.other).toBe(2);
  });
});
