import { render } from "@solidjs/testing-library";
import { SOURCE_REGISTRY } from "@shared/sources";
import { describe, expect, it } from "vitest";
import { hasSourceIcon } from "../lib/source-styles";
import SourceIcon from "./SourceIcon";

describe("SourceIcon", () => {
  it.each(["spotify", "skype", "swarm", "journal", "thriva"])(
    "renders the %s icon as a monochrome svg",
    (source) => {
      const { container } = render(() => <SourceIcon source={source} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.querySelector('[fill="currentColor"]')).not.toBeNull();
      expect(svg?.getAttribute("width")).toBe("1em");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(container.textContent).toBe("");
    },
  );

  it("uses the source family icon for source variants", () => {
    const base = render(() => <SourceIcon source="spotify" />);
    const variant = render(() => <SourceIcon source="spotify-friends" />);
    expect(variant.container.innerHTML).toBe(base.container.innerHTML);
  });

  it("uses an svg fallback for unknown sources", () => {
    const { container } = render(() => <SourceIcon source="not-a-real-source" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('[fill="currentColor"]')).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("does not treat inherited object properties as registered icons", () => {
    const fallback = render(() => <SourceIcon source="not-a-real-source" />);
    const inherited = render(() => <SourceIcon source="constructor" />);

    expect(inherited.container.innerHTML).toBe(fallback.container.innerHTML);
    expect(hasSourceIcon("constructor")).toBe(false);
  });

  it("has an icon for every registered source", () => {
    expect(SOURCE_REGISTRY.filter((source) => !hasSourceIcon(source.id))).toEqual([]);
  });
});
