/**
 * Test setup - runs before any test files are loaded.
 * Isolates config and database paths from the developer's host environment.
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createTestFetchGuard } from "../src/testing/fetch-guard";

// Tests may replace globalThis.fetch with a route-specific mock, but restoring
// it must never expose Bun's unrestricted implementation. Keep loopback access
// for integration tests that start a local server and fail every unexpected
// external request before it can reach third-party infrastructure.
globalThis.fetch = createTestFetchGuard(globalThis.fetch);

// Load application modules only after the network guard is active so future
// top-level initialization cannot accidentally make an external request.
const [{ configureBunSqliteForSqliteVec }, { initProviders }] = await Promise.all([
  import("../src/embeddings/sqlite-vec"),
  import("../src/llm"),
]);

// Isolate tests from the developer's host config (~/.config/timeline/config.toml),
// which may enable optional backends like [media.r2] whose secrets aren't present
// in the test env. Point TIMELINE_CONFIG and TIMELINE_ENV_FILE at empty files so
// loadConfig() resolves to built-in defaults - matching CI, where no host config
// exists. Must run before any test imports the config module.
const testConfigPath = join(tmpdir(), `timeline-test-config-${Date.now()}.toml`);
writeFileSync(testConfigPath, "");
process.env.TIMELINE_CONFIG = testConfigPath;

const testEnvPath = join(tmpdir(), `timeline-test-env-${Date.now()}`);
writeFileSync(testEnvPath, "");
process.env.TIMELINE_ENV_FILE = testEnvPath;

// Create a temp database for tests
// app-state.db will be created alongside it automatically (same directory)
const testDbPath = join(tmpdir(), `timeline-test-${Date.now()}.db`);
process.env.TIMELINE_DB_PATH = testDbPath;

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

console.log(`Test database: ${testDbPath}`);
