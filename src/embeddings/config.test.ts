import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_EMBEDDING_ENV_VARS, loadConfig } from "../config";
import { resolveEmbeddingProfile } from "./config";

let workDir: string;
let savedConfigPath: string | undefined;
const savedLegacyEnv = new Map<string, string | undefined>();

// Point loadConfig at a per-test TOML file and clear the legacy embedding env so
// the not-configured message is deterministic regardless of the developer's shell.
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-embeddings-config-"));
  savedConfigPath = process.env.TIMELINE_CONFIG;
  for (const key of LEGACY_EMBEDDING_ENV_VARS) {
    savedLegacyEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  process.env.TIMELINE_CONFIG = savedConfigPath;
  for (const [key, value] of savedLegacyEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function loadEmbeddings(toml: string) {
  const path = join(workDir, "config.toml");
  writeFileSync(path, toml);
  process.env.TIMELINE_CONFIG = path;
  return (await loadConfig()).embeddings;
}

describe("[embeddings] config", () => {
  test("is absent unless configured", async () => {
    expect(await loadEmbeddings("[server]\nport = 3001\n")).toBeUndefined();
  });

  test("resolves a profile against <base_url>/embeddings with prompt prefixes", async () => {
    const embeddings = await loadEmbeddings(`
[embeddings]
base_url = "http://gpu.example.com:8080/v1/"
model = "embeddinggemma-2"
dimensions = 768
document_prefix = "title: none | text: "
query_prefix = "task: search result | query: "
`);
    expect(resolveEmbeddingProfile(embeddings)).toEqual({
      name: "embeddinggemma-2:768",
      provider: "openai-compatible",
      endpoint: "http://gpu.example.com:8080/v1/embeddings",
      model: "embeddinggemma-2",
      dimensions: 768,
      api_key_env: null,
      document_prefix: "title: none | text: ",
      query_prefix: "task: search result | query: ",
      timeout_ms: 60_000,
    });
  });

  test("defaults prefixes to empty and honours an explicit profile name", async () => {
    const embeddings = await loadEmbeddings(`
[embeddings]
base_url = "http://127.0.0.1:1234/v1"
model = "text-embedding-bge-m3"
dimensions = 1024
profile = "experiment-a"
api_key_env = "EMBEDDING_KEY"
`);
    const profile = resolveEmbeddingProfile(embeddings);
    expect(profile.name).toBe("experiment-a");
    expect(profile.api_key_env).toBe("EMBEDDING_KEY");
    expect(profile.document_prefix).toBe("");
    expect(profile.query_prefix).toBe("");
  });

  test("converts timeout_seconds to the client's request timeout", async () => {
    const embeddings = await loadEmbeddings(`
[embeddings]
base_url = "http://127.0.0.1:1234/v1"
model = "m"
dimensions = 3
timeout_seconds = 2.5
`);
    expect(resolveEmbeddingProfile(embeddings).timeout_ms).toBe(2500);
  });

  test.each([
    ['base_url = "http://127.0.0.1:1234/v1"\nmodel = "m"', /dimensions must be a positive integer/],
    ['base_url = "http://127.0.0.1:1234/v1"\nmodel = "m"\ndimensions = 0', /dimensions must be a positive integer/],
    ['model = "m"\ndimensions = 3', /base_url must be a non-empty string/],
    ['base_url = "not a url"\nmodel = "m"\ndimensions = 3', /base_url is not a valid URL/],
    ['base_url = "http://127.0.0.1:1234/v1"\nmodel = "m"\ndimensions = 3\nendpoint = "x"', /unknown key "endpoint"/],
    ['base_url = "http://127.0.0.1:1234/v1"\nmodel = "m"\ndimensions = 3\nquery_prefix = 1', /query_prefix must be a string/],
    ['base_url = "http://127.0.0.1:1234/v1"\nmodel = "m"\ndimensions = 3\ntimeout_seconds = 0', /timeout_seconds must be a positive number/],
    ['base_url = "http://127.0.0.1:1234/v1"\nmodel = "m"\ndimensions = 3\ntimeout_seconds = "60"', /timeout_seconds must be a positive number/],
  ])("rejects an invalid section: %s", async (body, message) => {
    await expect(loadEmbeddings(`[embeddings]\n${body}\n`)).rejects.toThrow(message);
  });

  test("an unconfigured host gets a setup message naming any legacy env vars", () => {
    expect(() => resolveEmbeddingProfile(undefined)).toThrow(/add an \[embeddings\] section/);
    process.env.TIMELINE_EMBEDDING_ENDPOINT = "http://127.0.0.1:1234/v1/embeddings";
    expect(() => resolveEmbeddingProfile(undefined)).toThrow(/TIMELINE_EMBEDDING_ENDPOINT is no longer read/);
  });
});
