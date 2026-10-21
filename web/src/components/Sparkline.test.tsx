import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import Sparkline from "./Sparkline";

describe("Sparkline", () => {
  it("renders a polyline scaled between the series min and max", () => {
    const { container } = render(() => (
      <Sparkline data={[0, 10]} width={100} height={28} />
    ));
    const polyline = container.querySelector("polyline");
    expect(polyline).not.toBeNull();
    // min maps to the baseline (h - pad), max to the top (pad).
    expect(polyline?.getAttribute("points")).toBe("0.00,26.00 100.00,2.00");
  });

  it("renders nothing for fewer than two points", () => {
    const { container } = render(() => <Sparkline data={[5]} />);
    expect(container.querySelector("polyline")).toBeNull();
  });

  it("handles a flat series without dividing by zero", () => {
    const { container } = render(() => (
      <Sparkline data={[7, 7, 7]} width={100} height={28} />
    ));
    const points = container.querySelector("polyline")?.getAttribute("points");
    expect(points).toBeTruthy();
    // No NaN coordinates when min === max.
    expect(points).not.toContain("NaN");
  });
});
