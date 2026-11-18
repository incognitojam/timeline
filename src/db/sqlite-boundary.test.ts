import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

// These diagnostics deliberately select or inspect a library before application setup.
const DIRECT_IMPORT_TOOLS = new Set([
  "scripts/sqlite/pin.ts",
  "scripts/sqlite/verify-library.ts",
  "src/scripts/sqlite-check-compat.ts",
]);

function hasEmbeddedValueImport(source: string): boolean {
  const code = source.replace(/import\s+type\s+\w+\s*=\s*require\([^)]*\)/g, "");
  if (/\b(?:require|import)\s*\(\s*["']bun:sqlite["']\s*\)(?!\s*\.)/.test(code)) return true;
  for (const match of code.matchAll(/\b(?:import|export)\s+(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s*["']bun:sqlite["']/g)) {
    const binding = match[1];
    if (!binding) continue;
    if (!binding.startsWith("{")) return true;
    if (binding.slice(1, -1).split(",").some(part => part.trim() && !/^type\s/.test(part.trim()))) return true;
  }
  return false;
}

test("embedded SQLite imports distinguish values from types", () => {
  expect(hasEmbeddedValueImport('const { Database } = require("bun:sqlite");')).toBe(true);
  expect(hasEmbeddedValueImport('import { type SQLQueryBindings, Database } from "bun:sqlite";')).toBe(true);
  expect(hasEmbeddedValueImport('import { type SQLQueryBindings } from "bun:sqlite";')).toBe(false);
  expect(hasEmbeddedValueImport('import type Sqlite = require("bun:sqlite");')).toBe(false);
  expect(hasEmbeddedValueImport('type D = import("bun:sqlite").Database;')).toBe(false);
});

test("SQLite value imports go through src/db/sqlite.ts", async () => {
  const violations: string[] = [];
  for (const directory of ["src", "scripts", "test", "web/src"]) {
    for await (const file of new Bun.Glob("**/*.{ts,tsx,js,mjs}").scan({ cwd: resolve(root, directory) })) {
      const path = `${directory}/${file}`;
      // This test's own import snippets are boundary fixtures, not subprocess programs.
      if (path === "src/db/sqlite.ts" || path === "src/db/sqlite-boundary.test.ts" || DIRECT_IMPORT_TOOLS.has(path) || file.endsWith(".d.ts")) continue;
      const source = await Bun.file(resolve(root, path)).text();
      const transpiler = new Bun.Transpiler({ loader: file.endsWith("tsx") ? "tsx" : "ts" });
      if (transpiler.scanImports(source.replace(/^#!.*/, "")).some((entry) => entry.path === "bun:sqlite")) {
        violations.push(path);
      }
      // Subprocess programs in template strings aren't imports in the containing AST.
      if (hasEmbeddedValueImport(source)) violations.push(`${path} (subprocess)`);
    }
  }
  expect(violations).toEqual([]);
});

test("SQLite re-exports work in a Bun bundle", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const directory = mkdtempSync(resolve(tmpdir(), "sqlite-bundle-"));
  try {
    const entry = resolve(directory, "entry.ts");
    await Bun.write(entry, `import { Database } from ${JSON.stringify(resolve(root, "src/db/sqlite.ts"))};
      using db = new Database(":memory:");
      console.log(JSON.stringify(db.query("SELECT 1 value").get()));`);
    const result = await Bun.build({ entrypoints: [entry], outdir: resolve(directory, "bundle"), target: "bun" });
    expect(result.success).toBe(true);
    const child = Bun.spawn([process.execPath, resolve(directory, "bundle/entry.js")], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr, stdout: stdout.trim() }).toEqual({ code: 0, stderr: "", stdout: '{"value":1}' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
