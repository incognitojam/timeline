import { describe, expect, test } from "vitest";
import {
  getRangeSelectionHighlightClass,
  getInclusiveLoadedRangeIds,
  getRangeVisualPositions,
  nextRangeEndpointState,
} from "./conversation-range-selection";

describe("conversation range selection", () => {
  test("first click sets start and second click sets end", () => {
    const first = nextRangeEndpointState({ startEventId: null, endEventId: null }, 10);
    expect(first).toEqual({ startEventId: 10, endEventId: null });

    const second = nextRangeEndpointState(first, 20);
    expect(second).toEqual({ startEventId: 10, endEventId: 20 });
  });

  test("clicking after a completed range starts a new range", () => {
    const next = nextRangeEndpointState({ startEventId: 10, endEventId: 20 }, 30);
    expect(next).toEqual({ startEventId: 30, endEventId: null });
  });

  test("inclusive loaded range supports forward and reverse endpoints", () => {
    const ids = [10, 20, 30, 40];

    expect([...getInclusiveLoadedRangeIds(ids, { startEventId: 20, endEventId: 40 })]).toEqual([20, 30, 40]);
    expect([...getInclusiveLoadedRangeIds(ids, { startEventId: 40, endEventId: 20 })]).toEqual([20, 30, 40]);
  });

  test("visual positions describe the loaded selected group", () => {
    const positions = getRangeVisualPositions([10, 20, 30, 40], new Set([20, 30, 40]));

    expect(Object.fromEntries(positions)).toEqual({
      20: "first",
      30: "middle",
      40: "last",
    });
  });

  test("visual positions support single loaded selection", () => {
    const positions = getRangeVisualPositions([10, 20, 30], new Set([20]));

    expect(Object.fromEntries(positions)).toEqual({ 20: "single" });
  });

  test("selection highlight uses an opaque surface to avoid overlap bands", () => {
    const className = getRangeSelectionHighlightClass("middle");

    expect(className).toContain("after:bg-accent");
    expect(className).not.toContain("after:bg-primary/10");
  });

  test("multi-row selection avoids internal shadow seams", () => {
    expect(getRangeSelectionHighlightClass("first")).not.toContain("after:shadow-sm");
    expect(getRangeSelectionHighlightClass("middle")).not.toContain("after:shadow-sm");
    expect(getRangeSelectionHighlightClass("last")).not.toContain("after:shadow-sm");
    expect(getRangeSelectionHighlightClass("single")).toContain("after:shadow-sm");
  });
});
