import { expect, test } from "bun:test";
import {
  preparePackagedBootstrapEnvironment,
  validatePackagedConfigPaths,
} from "./packaged-paths";
import type { ServiceConfig } from "./types";

function packagedConfig(): ServiceConfig {
  return {
    server: { host: "127.0.0.1", port: 3001 },
    database: { path: "/data/timeline.db" },
    scheduler: { enabled: true, default_interval: "1h", stagger: true },
    sync: {},
    inbox: {
      watch_enabled: true,
      base_path: "/data/inbox",
      archive_path: "/data/archive",
      sources: {},
    },
    media: { path: "/data/media" },
    backup: {},
    llm: { providers: {} },
  };
}

test("packaged bootstrap rejects relative environment paths", () => {
  for (const key of [
    "TIMELINE_CONFIG",
    "TIMELINE_DB_PATH",
    "TIMELINE_EMBEDDINGS_DB_PATH",
    "TIMELINE_INBOX_PATH",
    "TIMELINE_MEDIA_PATH",
    "TIMELINE_SQLITE_LIBRARY_PATH",
    "DISCORD_DB_PATH",
    "RCLONE_CONFIG",
  ]) {
    expect(() =>
      preparePackagedBootstrapEnvironment({ [key]: "./relative-path" }),
    ).toThrow(`${key} must be an absolute path`);
  }
});

test("packaged bootstrap rejects empty environment paths", () => {
  expect(() =>
    preparePackagedBootstrapEnvironment({ TIMELINE_CONFIG: "" }),
  ).toThrow("TIMELINE_CONFIG must be an absolute path");
});

test("packaged bootstrap accepts absent and absolute environment paths", () => {
  expect(() => preparePackagedBootstrapEnvironment({})).not.toThrow();
  expect(() =>
    preparePackagedBootstrapEnvironment({
      TIMELINE_CONFIG: "/config/timeline.toml",
      TIMELINE_DB_PATH: "/data/timeline.db",
      TIMELINE_INBOX_PATH: "/data/inbox",
      TIMELINE_MEDIA_PATH: "/data/media",
    }),
  ).not.toThrow();
});

test("packaged bootstrap expands home-relative environment paths", () => {
  const env = {
    HOME: "/Users/alice",
    TIMELINE_EMBEDDINGS_DB_PATH: "~/.local/share/timeline/embeddings.db",
  };
  preparePackagedBootstrapEnvironment(env);
  expect(env.TIMELINE_EMBEDDINGS_DB_PATH).toBe(
    "/Users/alice/.local/share/timeline/embeddings.db",
  );
});

test("packaged config rejects relative filesystem paths", () => {
  for (const mutate of [
    (config: ServiceConfig) => { config.database.path = "./timeline.db"; },
    (config: ServiceConfig) => { config.inbox.base_path = "./inbox"; },
    (config: ServiceConfig) => { config.inbox.archive_path = "./archive"; },
    (config: ServiceConfig) => { config.media.path = "./media"; },
  ]) {
    const config = packagedConfig();
    mutate(config);
    expect(() => validatePackagedConfigPaths(config)).toThrow("must be an absolute path");
  }
});

test("packaged config accepts absolute filesystem paths", () => {
  expect(() => validatePackagedConfigPaths(packagedConfig())).not.toThrow();
});
