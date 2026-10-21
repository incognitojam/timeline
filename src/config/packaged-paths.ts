import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SyncSource } from "../sync/types";
import type { ServiceConfig, SyncSourceConfig } from "./types";

function requireAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new Error(
      `${label} must be an absolute path for the packaged service: ${path}. ` +
        "Use an absolute path or a path beginning with ~/.",
    );
  }
}

function normalizeHomePath(path: string, env: NodeJS.ProcessEnv): string {
  return path.startsWith("~/")
    ? join(env.HOME ?? homedir(), path.slice(2))
    : path;
}

export function preparePackagedBootstrapEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, label] of [
    ["TIMELINE_CONFIG", "TIMELINE_CONFIG"],
    ["TIMELINE_DB_PATH", "TIMELINE_DB_PATH"],
    ["TIMELINE_EMBEDDINGS_DB_PATH", "TIMELINE_EMBEDDINGS_DB_PATH"],
    ["TIMELINE_INBOX_PATH", "TIMELINE_INBOX_PATH"],
    ["TIMELINE_MEDIA_PATH", "TIMELINE_MEDIA_PATH"],
    ["TIMELINE_SQLITE_LIBRARY_PATH", "TIMELINE_SQLITE_LIBRARY_PATH"],
    ["DISCORD_DB_PATH", "DISCORD_DB_PATH"],
    ["RCLONE_CONFIG", "RCLONE_CONFIG"],
  ] as const) {
    const value = env[key];
    if (value === undefined) continue;
    const normalized = normalizeHomePath(value, env);
    requireAbsolutePath(normalized, label);
    env[key] = normalized;
  }
}

export function validatePackagedConfigPaths(config: ServiceConfig): void {
  requireAbsolutePath(config.database.path, "database.path");
  requireAbsolutePath(config.inbox.base_path, "inbox.base_path");
  if (config.inbox.archive_path) {
    requireAbsolutePath(config.inbox.archive_path, "inbox.archive_path");
  }
  requireAbsolutePath(config.media.path, "media.path");
}

export function preparePackagedSyncSettings(
  source: string,
  settings: SyncSourceConfig,
  schema: NonNullable<SyncSource["configSchema"]>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const field of schema) {
    if (field.type !== "string" || field.format !== "path") continue;
    const value = settings[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      throw new Error(`sync.${source}.${field.key} must be a path string`);
    }
    const normalized = normalizeHomePath(value, env);
    requireAbsolutePath(normalized, `sync.${source}.${field.key}`);
    settings[field.key] = normalized;
  }
}

export function preparePackagedSyncSourcePaths(
  sources: Record<string, SyncSourceConfig>,
  registeredSources: Pick<SyncSource, "name" | "configSchema">[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const schemas = new Map(
    registeredSources.map((source) => [source.name, source.configSchema]),
  );
  for (const [source, settings] of Object.entries(sources)) {
    const schema = schemas.get(source);
    if (schema) preparePackagedSyncSettings(source, settings, schema, env);
  }
}
