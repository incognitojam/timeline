import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DOCUMENT_GLOBS = [
  "*.md",
  "docs/**/*.md",
  "deploy/**/*",
  ".agents/**/*.md",
  "tools/*/*.md",
  "package.json",
];

/** Repo-relative scripts named in `bun run <path>.ts` commands. Placeholders such as `<name>` don't match. */
export function documentedScriptPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/\bbun run ["']?(?:\.\/)?((?:src|scripts|tools)\/[\w./-]+\.ts)\b/g)) {
    paths.add(match[1] as string);
  }
  return [...paths];
}

describe("documentedScriptPaths", () => {
  test("finds concrete paths and skips placeholders", () => {
    const text = "Run `bun run src/parsers/spotify.ts ./imports` or bun run src/parsers/<name>.ts, then bun run dev.";
    expect(documentedScriptPaths(text)).toEqual(["src/parsers/spotify.ts"]);
  });

  test("finds paths written with ./ or quotes", () => {
    const text = `bun run ./src/a.ts, bun run "src/b.ts" and bun run 'scripts/c.ts'`;
    expect(documentedScriptPaths(text)).toEqual(["src/a.ts", "src/b.ts", "scripts/c.ts"]);
  });
});

describe("documented script paths", () => {
  test("every `bun run` script in docs, deploy files and package.json exists", async () => {
    const missing: string[] = [];
    for (const pattern of DOCUMENT_GLOBS) {
      for await (const file of new Glob(pattern).scan({ cwd: REPO_ROOT, dot: true, onlyFiles: true })) {
        for (const path of documentedScriptPaths(readFileSync(join(REPO_ROOT, file), "utf8"))) {
          if (!existsSync(join(REPO_ROOT, path))) missing.push(`${file}: ${path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
