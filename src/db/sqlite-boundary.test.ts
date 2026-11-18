import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

test("SQLite value imports go through src/db/sqlite.ts", async () => {
  const violations: string[] = [];
  for (const directory of ["src", "scripts", "test", "web/src"]) {
    for await (const file of new Bun.Glob("**/*.{ts,tsx,js,mjs}").scan({ cwd: resolve(root, directory) })) {
      const path = `${directory}/${file}`;
      if (path === "src/db/sqlite.ts" || file.endsWith(".d.ts")) continue;
      const source = await Bun.file(resolve(root, path)).text();
      const transpiler = new Bun.Transpiler({ loader: file.endsWith("tsx") ? "tsx" : "ts" });
      if (transpiler.scanImports(source.replace(/^#!.*/, "")).some((entry) => entry.path === "bun:sqlite")) {
        violations.push(path);
      }
      // Subprocess programs in template strings aren't imports in the containing AST.
      if (/^\s*import\s+\{(?!\s*type\b)[^}]*\}\s+from\s*["']bun:sqlite["']/m.test(source)) {
        violations.push(`${path} (subprocess)`);
      }
    }
  }
  expect(violations).toEqual([]);
});
