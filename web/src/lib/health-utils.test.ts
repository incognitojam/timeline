import { describe, expect, it } from "vitest";
import { niceAxisBounds, normalizeRangePosition, referenceRangeExtent } from "./health-utils";

describe("niceAxisBounds", () => {
  it("pads a constant heart-rate series to finite axis bounds", () => {
    const heartRates = [62, 62, 62];
    const bounds = niceAxisBounds(Math.min(...heartRates), Math.max(...heartRates));

    expect(Number.isFinite(bounds.min)).toBe(true);
    expect(Number.isFinite(bounds.max)).toBe(true);
    expect(bounds.max).toBeGreaterThan(bounds.min);
    expect(bounds.max - bounds.min).toBeGreaterThanOrEqual(1);
  });

  it("pads a single-point heart-rate series to finite axis bounds", () => {
    const heartRates = [62];
    const bounds = niceAxisBounds(Math.min(...heartRates), Math.max(...heartRates));

    expect(Number.isFinite(bounds.min)).toBe(true);
    expect(Number.isFinite(bounds.max)).toBe(true);
    expect(bounds.max).toBeGreaterThan(bounds.min);
    expect(bounds.max - bounds.min).toBeGreaterThanOrEqual(1);
  });
});

describe("referenceRangeExtent", () => {
  it("normalizes an upper-open range above the fallback maximum", () => {
    const extent = referenceRangeExtent([{ name: "High", level: "normal", lower_bound: 120, upper_bound: null }]);
    const markerPosition = normalizeRangePosition(125, extent.min, extent.max);

    expect(Number.isFinite(extent.min)).toBe(true);
    expect(Number.isFinite(extent.max)).toBe(true);
    expect(extent.max).toBeGreaterThan(extent.min);
    expect(markerPosition).toBeGreaterThanOrEqual(0);
    expect(markerPosition).toBeLessThanOrEqual(1);
  });
});
