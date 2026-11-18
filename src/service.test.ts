import { afterAll, afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string | null = null;

// A spawned service still running when its test fails or times out.
let runningService: { exited: Promise<unknown>; kill: () => void } | null = null;

afterEach(async () => {
  if (runningService) {
    runningService.kill();
    await runningService.exited;
    runningService = null;
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

test("service fails auth preflight before starting the worker", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-service-auth-"));
  const configPath = join(workDir, "config.toml");
  const dbPath = join(workDir, "timeline.db");

  writeFileSync(
    configPath,
    `[scheduler]
enabled = true
stagger = false

[inbox]
watch_enabled = false
`
  );

  const proc = Bun.spawn([process.execPath, "run", "src/service.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TIMELINE_CONFIG: configPath,
      TIMELINE_DB_PATH: dbPath,
      NODE_ENV: "production",
      AUTH_PASSWORD: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  expect(proc.exitCode).not.toBe(0);
  expect(stderr).toContain("AUTH_PASSWORD must be set outside development");
  expect(stdout).not.toContain("Scheduler worker started");
  expect(existsSync(join(workDir, "app-state.db"))).toBe(false);
});

/** Boots the service with an inbox source the worker cannot watch, so worker init fails. */
async function runServiceWithFailingWorker(dir: string) {
  const configPath = join(dir, "config.toml");
  const dbPath = join(dir, "timeline.db");
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "x");

  writeFileSync(
    configPath,
    `[server]
host = "127.0.0.1"
port = 0

[database]
path = ${JSON.stringify(dbPath)}

[scheduler]
enabled = true
default_interval = "1h"
stagger = false

[inbox]
watch_enabled = true
base_path = ${JSON.stringify(dir)}

[inbox.sources.bad]
type = "local"
local = ${JSON.stringify(join(blocker, "google"))}
parser = "noop"

[media]
path = ${JSON.stringify(join(dir, "media"))}
`
  );

  const proc = Bun.spawn([process.execPath, "run", "src/service.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TIMELINE_CONFIG: configPath,
      TIMELINE_DB_PATH: dbPath,
      TIMELINE_ENV_FILE: join(dir, "missing.env"),
      NODE_ENV: "development",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Cold service and worker imports take as long as a loaded machine needs, so
  // wait for the exit itself; the test timeout bounds a service that never exits.
  runningService = proc;
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  runningService = null;
  return { dbPath, exitCode, stdout, stderr };
}

// The next two tests check the same failed boot, so the service starts once.
let failedBootDir: string | null = null;
let failedBoot: ReturnType<typeof runServiceWithFailingWorker> | null = null;

async function bootWithFailingWorker() {
  failedBootDir ??= mkdtempSync(join(tmpdir(), "timeline-service-worker-init-"));
  const result = await (failedBoot ??= runServiceWithFailingWorker(failedBootDir));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Failed to start scheduler worker");
  expect(result.stderr).toContain("Worker initialization failed");
  return result;
}

afterAll(() => {
  if (failedBootDir) rmSync(failedBootDir, { recursive: true, force: true });
});

test("service exits before serving when worker init fails", async () => {
  const { stdout } = await bootWithFailingWorker();
  expect(stdout).not.toContain("Timeline service is running");
});

test("database is initialised even when the scheduler worker fails to start", async () => {
  // The worker cannot start, so the service exits before ever importing the
  // API. initDb() must therefore already have run: nothing else creates the
  // schema. The derived-table rebuilds inside it read every event in one
  // transaction, which a sync committing mid-rebuild would abort.
  const { dbPath, stdout } = await bootWithFailingWorker();
  expect(stdout).not.toContain("Starting Timeline API");
  expect(stdout).toContain("Database ready");

  // Assert the schema, not the file: opening a database creates the file, so
  // file existence alone would pass even if initDb() never ran.
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('events', 'conversation_summaries')")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["conversation_summaries", "events"]);
  } finally {
    db.close();
  }
});
