import { PLATFORM_METAS } from "@platforms/metas";
import { SOURCE_REGISTRY } from "@shared/sources";
import { describe, expect, it } from "vitest";
import { getSourceIcon } from "../lib/source-styles";
import * as Icons from "../ui/icons";
import { PLATFORM_DISPLAYS } from ".";

describe("PLATFORM_DISPLAYS", () => {
  it("has one display per platform, in the same order", () => {
    expect(PLATFORM_DISPLAYS.map((display) => display.meta)).toEqual([...PLATFORM_METAS]);
  });

  it("resolves every registered source to a non-fallback icon", () => {
    for (const source of SOURCE_REGISTRY) {
      expect(getSourceIcon(source.id)).not.toBe(Icons.IconCircle);
    }
  });
});
