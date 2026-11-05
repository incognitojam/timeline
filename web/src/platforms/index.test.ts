import { PLATFORM_METAS } from "@platforms/metas";
import { describe, expect, it } from "vitest";
import { getSourceIcon } from "../lib/source-styles";
import { PLATFORM_DISPLAYS } from ".";

describe("PLATFORM_DISPLAYS", () => {
  it("has one display per platform, in the same order", () => {
    expect(PLATFORM_DISPLAYS.map((display) => display.meta)).toEqual([...PLATFORM_METAS]);
  });

  it.each(PLATFORM_DISPLAYS.flatMap((display) => display.meta.sources.map((source) => [source.id, display.icon] as const)))(
    "uses the platform icon for %s",
    (source, icon) => {
      expect(getSourceIcon(source)).toBe(icon);
    },
  );
});
