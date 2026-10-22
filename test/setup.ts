/**
 * Test setup - runs before any test files are loaded.
 * Isolates every host path (config, secrets, databases, media, inbox, home
 * directory, temporary files) from the developer's environment.
 */

import { afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import * as os from "os";
import { join } from "path";
import { createTestFetchGuard } from "../src/testing/fetch-guard";

// Tests may replace globalThis.fetch with a route-specific mock, but restoring
// it must never expose Bun's unrestricted implementation. Keep loopback access
// for integration tests that start a local server and fail every unexpected
// external request before it can reach third-party infrastructure.
globalThis.fetch = createTestFetchGuard(globalThis.fetch);

// Everything a run writes lives under one directory, removed when the run
// finishes. Its name carries the owning pid so a later run can remove directories
// left behind by a run that was killed before its cleanup ran.
const RUN_ROOT_PREFIX = "timeline-test-run-";
const hostTmpdir = os.tmpdir();
for (const entry of readdirSync(hostTmpdir)) {
  const pid = Number(entry.slice(RUN_ROOT_PREFIX.length).split("-")[0]);
  if (!entry.startsWith(RUN_ROOT_PREFIX) || !Number.isInteger(pid) || isAlive(pid)) continue;
  try {
    rmSync(join(hostTmpdir, entry), { recursive: true, force: true });
  } catch (error) {
    // Another user's leftovers must not stop this run.
    console.warn(`Could not remove stale test run directory ${entry}: ${error}`);
  }
}
const runRoot = mkdtempSync(join(hostTmpdir, `${RUN_ROOT_PREFIX}${process.pid}-`));
// A preload-level afterAll runs once, after every test file.
afterAll(() => rmSync(runRoot, { recursive: true, force: true }));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runPath(name: string, kind: "dir" | "file" = "dir"): string {
  const path = join(runRoot, name);
  if (kind === "dir") mkdirSync(path);
  else writeFileSync(path, "");
  return path;
}

// os.tmpdir() reads TMPDIR on every call, so test temp files land in the run
// directory.
process.env.TMPDIR = runPath("tmp");

// Parsers and sync sources resolve token files and default data paths from
// os.homedir(), which Bun caches at startup and does not re-read from HOME.
// mock.module covers named, namespace, and dynamic imports; require() and
// default imports share the builtin module object, so replace it there too.
const testHome = runPath("home");
process.env.HOME = testHome;
const testHomedir = () => testHome;
for (const specifier of ["os", "node:os"]) {
  mock.module(specifier, () => ({ ...os, homedir: testHomedir, default: { ...os, homedir: testHomedir } }));
  createRequire(import.meta.url)(specifier).homedir = testHomedir;
}

// Bun.spawn, Bun.spawnSync, and Worker default to the environment the process
// started with, not process.env as changed above, so give them process.env
// unless a caller passes its own. A worker's os.homedir() still returns the real
// home; its database, media, inbox, and config paths come from the variables below.
type SpawnOptions = { env?: Record<string, string | undefined> } | undefined;
const withEnv = <T extends SpawnOptions>(options: T) => (options?.env ? options : { ...options, env: process.env });
function inheritEnv<F extends (...args: never[]) => unknown>(spawn: F): F {
  return ((command: unknown, options?: SpawnOptions) =>
    Array.isArray(command)
      ? (spawn as (...args: unknown[]) => unknown)(command, withEnv(options))
      : (spawn as (...args: unknown[]) => unknown)(withEnv(command as SpawnOptions))) as F;
}
Object.assign(Bun, { spawn: inheritEnv(Bun.spawn), spawnSync: inheritEnv(Bun.spawnSync) });
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, withEnv(options as SpawnOptions) as WorkerOptions);
  }
};

// Empty bootstrap config and secrets resolve to built-in defaults, matching CI
// where no host config exists. The developer's config may enable optional
// backends like [media.r2] whose secrets aren't present in the test env.
process.env.TIMELINE_CONFIG = runPath("config.toml", "file");
process.env.TIMELINE_ENV_FILE = runPath("env", "file");
process.env.TIMELINE_MEDIA_PATH = runPath("media");
process.env.TIMELINE_INBOX_PATH = runPath("inbox");

// app-state.db and embeddings.db are created alongside timeline.db.
const testDbPath = join(runPath("data"), "timeline.db");
process.env.TIMELINE_DB_PATH = testDbPath;

// Load application modules only after the network guard and path isolation are
// active, so top-level initialization can neither make an external request nor
// capture a host path.
const [{ configureBunSqliteForSqliteVec }, { initProviders }] = await Promise.all([
  import("../src/embeddings/sqlite-vec"),
  import("../src/llm"),
]);

// Pre-create the database so it exists when schema.ts validates
configureBunSqliteForSqliteVec();
const db = new Database(testDbPath);
db.close();

// Give tests a deterministic default LLM provider. Production calls
// initProviders() at startup (src/api/index.ts), but API tests import the app in
// NODE_ENV=test, which skips that. Without a configured provider getDefaultModel()
// throws, so any test hitting a summary/journal route would otherwise depend on
// whether an earlier LLM test happened to leave the shared registry populated. The
// stub fetch keeps discovery offline.
await initProviders(
  {
    providers: {
      test: { kind: "openai-compatible", base_url: "http://llm.test/v1", models: ["test-model"] },
    },
  },
  {
    fetch: async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  },
);

console.log(`Test run directory: ${runRoot}`);
