import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENTS_PATH, renderSourcesTable, withSourcesTable } from "./docs-sources";

describe("data sources table", () => {
  test("AGENTS.md matches platform metadata (run `bun run docs:sources`)", () => {
    const markdown = readFileSync(AGENTS_PATH, "utf8");
    expect(markdown).toBe(withSourcesTable(markdown, renderSourcesTable()));
  });



  test("fails loudly when the markers are missing", () => {
    expect(() => withSourcesTable("no markers", "new")).toThrow("markers");
  });
});
