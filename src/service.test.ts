import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string | null = null;

async function waitForExit(
  proc: { exited: Promise<unknown>; kill: () => void },
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);

  if (!exited) {
    proc.kill();
    await proc.exited;
  }

  return exited;
}

afterEach(() => {
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

test("service exits before serving when worker init fails", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-service-worker-init-"));
  const configPath = join(workDir, "config.toml");
  const dbPath = join(workDir, "timeline.db");
  const blocker = join(workDir, "not-a-dir");
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
base_path = ${JSON.stringify(workDir)}

[inbox.sources.bad]
type = "local"
local = ${JSON.stringify(join(blocker, "google"))}
parser = "noop"

[media]
path = ${JSON.stringify(join(workDir, "media"))}
`
  );

  const proc = Bun.spawn([process.execPath, "run", "src/service.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TIMELINE_CONFIG: configPath,
      TIMELINE_DB_PATH: dbPath,
      TIMELINE_ENV_FILE: join(workDir, "missing.env"),
      NODE_ENV: "development",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Cold service and worker imports share CPU with the other suite checks in CI.
  const exited = await waitForExit(proc, 15_000);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  expect(exited).toBe(true);
  expect(proc.exitCode).not.toBe(0);
  expect(stderr).toContain("Failed to start scheduler worker");
  expect(stderr).toContain("Worker initialization failed");
  expect(stdout).not.toContain("Timeline service is running");
});
