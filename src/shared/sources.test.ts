import { describe, expect, test } from "bun:test";
import { VALID_PLATFORMS } from "../db/schema";
import {
  DEFAULT_SOURCE_COLOR,
  getSourceDefinition,
  SOURCE_REGISTRY,
  sourceColor,
  sourceLabel,
} from "./sources";

describe("source registry", () => {
  test("contains unique source IDs", () => {
    const ids = SOURCE_REGISTRY.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("registers every identity platform", () => {
    expect(VALID_PLATFORMS.filter((platform) => !getSourceDefinition(platform))).toEqual([]);
  });

  test("resolves registered source metadata", () => {
    expect(getSourceDefinition("google-messages")).toEqual({
      id: "google-messages",
      label: "Google Messages",
      color: "#1A73E8",
    });
    expect(sourceLabel("live")).toBe("Microsoft Live");
  });

  test("keeps unknown source IDs visible", () => {
    expect(sourceLabel("new-source")).toBe("new-source");
    expect(sourceColor("new-source")).toBe(DEFAULT_SOURCE_COLOR);
  });

  test("inherits colors for source families", () => {
    expect(sourceColor("google-takeout")).toBe(sourceColor("google"));
    expect(sourceColor("google-future-export")).toBe(sourceColor("google"));
    expect(getSourceDefinition("spotify-friends")?.color).toBe(
      getSourceDefinition("spotify")?.color,
    );
    expect(sourceColor("steam-future-source")).toBe(sourceColor("steam"));
    expect(getSourceDefinition("backup-offsite")?.color).toBe(
      getSourceDefinition("backup")?.color,
    );
    expect(sourceColor("spotify-future-source")).toBe(sourceColor("spotify"));
  });
});
