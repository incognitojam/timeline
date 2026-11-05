import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENTS_PATH, renderSourcesTable, withSourcesTable } from "./docs-sources";

describe("data sources table", () => {
  test("AGENTS.md matches platform metadata (run `bun run docs:sources`)", () => {
    const markdown = readFileSync(AGENTS_PATH, "utf8");
    expect(markdown).toBe(withSourcesTable(markdown, renderSourcesTable()));
  });

  test("lists event-producing sources and skips the rest and legacy types", () => {
    const metas = [
      { id: "zeta", color: "#000000", sources: [{ id: "zeta", label: "Zeta", eventTypes: ["zeta:post"] }] },
      {
        id: "alpha",
        color: "#000000",
        sources: [
          { id: "alpha", label: "Alpha", eventTypes: ["alpha:post", "alpha:reaction:*"], legacyEventTypes: ["alpha:old"] },
          { id: "alpha-channel", label: "Alpha Channel" },
          { id: "alpha-retired", label: "Alpha Retired", legacyEventTypes: ["alpha:gone"] },
        ],
      },
    ];
    expect(renderSourcesTable(metas, [{ id: "manual", label: "Manual", eventTypes: ["note"] }])).toBe(
      [
        "| Platform | Source | Event types |",
        "|----------|--------|-------------|",
        "| alpha | `alpha` | `alpha:post`, `alpha:reaction:*` |",
        "| zeta | `zeta` | `zeta:post` |",
        "| (built in) | `manual` | `note` |",
      ].join("\n"),
    );
  });

  test("replaces only the text between the markers", () => {
    const before = "intro\n<!-- sources:start -->\nold\n<!-- sources:end -->\noutro\n";
    expect(withSourcesTable(before, "new")).toBe("intro\n<!-- sources:start -->\nnew\n<!-- sources:end -->\noutro\n");
  });

  test("fails loudly when the markers are missing", () => {
    expect(() => withSourcesTable("no markers", "new")).toThrow("markers");
  });
});
