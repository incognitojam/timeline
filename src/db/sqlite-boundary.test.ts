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
