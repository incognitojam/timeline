import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");

test("stats-handler reads through every DbPool SQL method reach the failing gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "query-plan-api-probe-"));
  const probe = join(directory, "probe.test.ts");
  // Change only the child process's module load, not the repository or its API.
  const insertion = `
    await readDbPool.get("SELECT COUNT(*) AS pool_get_probe FROM events WHERE title = ?", "synthetic");
    await readDbPool.query("SELECT COUNT(*) AS pool_query_probe FROM events WHERE title = ?", "synthetic");
    await readDbPool.run("SELECT COUNT(*) AS pool_run_probe FROM events WHERE title = ?", "synthetic");
    const appPool = await DbPool.create(getAppStateDb().filename, { workers: 1 });
    try { await appPool.get("SELECT COUNT(*) AS pool_app_probe FROM jobs WHERE payload = ?", "synthetic"); }
    finally { await appPool.closeAndWait(); }
  `;
  writeFileSync(probe, `
    import { expect, test } from "bun:test";
    const anchor = 'app.get("/api/stats", async (c) => {';
    Bun.plugin({ name: "query-plan-api-probe", setup(builder) {
      builder.onLoad({ filter: /\\/api\\/index\\.ts$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        if (!source.includes(anchor)) throw new Error("Stats route anchor changed");
        return { contents: source.replace(anchor, anchor + ${JSON.stringify(insertion)}), loader: "ts" };
      });
    }});
    test("API query probe", async () => {
      const { app, shutdownApi } = await import(${JSON.stringify(join(root, "src/api/index.ts"))});
      try { expect((await app.request("/api/stats")).status).toBe(200); }
      finally { await shutdownApi(); }
    });
  `);
  const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", probe], {
    cwd: root, env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  for (const name of ["pool_get_probe", "pool_query_probe", "pool_run_probe", "pool_app_probe"]) {
    const database = name === "pool_app_probe" ? "app-state" : "timeline";
    expect(stderr).toMatch(new RegExp(`"database": "${database}",\\n  "sql": "[^\\n]*${name}`));
    expect(stderr).toContain(name);
  }
  expect(stderr).toContain("src/api/index.ts");
  expect(code).toBe(1);
  expect(stderr).toContain("Add an index or rewrite the query");
});

test("a schema-read lock cannot prevent close; recorder errors are deferred", () => {
  const directory = mkdtempSync(join(tmpdir(), "query-plan-close-probe-"));
  const program = `
    import { Database } from ${JSON.stringify(join(root, "src/db/sqlite.ts"))};
    import { initAppStateDb, getTrackImageUrls } from ${JSON.stringify(join(root, "src/db/app-state.ts"))};
    import { recordQueryPlans } from ${JSON.stringify(join(root, "src/testing/query-plans/recorder.ts"))};
    const finish = recordQueryPlans();
    const reader = new Database(${JSON.stringify(join(directory, "app-state.db"))});
    initAppStateDb(reader);
    getTrackImageUrls(reader, ["synthetic"]);
    const locker = new Database(reader.filename);
    locker.exec("BEGIN EXCLUSIVE");
    reader.close();
    let closed = false;
    try { reader.query("SELECT 1"); } catch { closed = true; }
    locker.exec("ROLLBACK");
    locker.close();
    console.log(JSON.stringify({ closed, errors: finish().collectionErrors }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", program], { env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.closed).toBe(true);
  expect(result.errors.some((error: string) => /locked|busy/i.test(error))).toBe(true);
});
