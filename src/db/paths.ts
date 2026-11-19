import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { parse as parseTOML } from "@iarna/toml";
import { expandPath, loadEnvFile, resolveEnvFilePath } from "../config";
import { APP_STATE_DB_FILE, EMBEDDINGS_DB_FILE } from "./sibling-files";

const DEFAULT_DB_PATH = "./timeline.db";
const HOST_CONFIG_PATH = join(homedir(), ".config", "timeline", "config.toml");
export const DEFAULT_HOST_DB_PATH = join(homedir(), ".local", "share", "timeline", "timeline.db");

/**
 * The Timeline host's production database: [database].path in the global host
 * config. Read directly rather than via loadConfig(), which honors
 * TIMELINE_DB_PATH and a cwd-relative ./timeline.db, so inside a worktree it
 * would resolve to the worktree's own development copy. Throws on an unreadable
 * or invalid config rather than guessing, since callers use it as a guard.
 */
export function getHostDbPath(): string {
  if (!existsSync(HOST_CONFIG_PATH)) return DEFAULT_HOST_DB_PATH;
  return configuredDbPath(HOST_CONFIG_PATH);
}

function configuredDbPath(configPath: string): string {
  let parsed: { database?: { path?: unknown } };
  try {
    parsed = parseTOML(readFileSync(configPath, "utf8")) as typeof parsed;
  } catch (err) {
    throw new Error(`Could not read ${configPath}: ${(err as Error).message}`);
  }
  const path = parsed.database?.path;
  if (path === undefined) return DEFAULT_HOST_DB_PATH;
  if (typeof path !== "string") throw new Error(`[database].path in ${configPath} must be a string`);
  return expandPath(path);
}

/**
 * The database the packaged service opens. Its launcher sources the env file
 * with bash, so this does the same in an otherwise empty environment, where
 * this process's own TIMELINE_DB_PATH can't stand in for the service's. Then,
 * as loadConfig does: TIMELINE_DB_PATH, else [database].path in the config
 * TIMELINE_CONFIG names (from the env file, or this process), else the default
 * config's, else the default path. Throws rather than guessing when the env
 * file or a named config can't be read.
 */
export function getServiceDbPath(): string {
  const envFile = resolveEnvFilePath();
  const sourced = Bun.spawnSync(
    ["/bin/bash", "-c", 'set -a; if [ -f "$1" ]; then . "$1" || exit 1; fi; printf "%s\\n%s\\n" "${TIMELINE_DB_PATH-}" "${TIMELINE_CONFIG-}"', "bash", envFile],
    { env: { HOME: homedir(), PATH: "/usr/bin:/bin" } },
  );
  if (sourced.exitCode !== 0) throw new Error(`Could not read ${envFile}: ${sourced.stderr.toString().trim()}`);
  const [dbPath, configFromEnvFile] = sourced.stdout.toString().split("\n");
  if (dbPath) return expandPath(dbPath);
  const config = configFromEnvFile || process.env.TIMELINE_CONFIG;
  if (!config) return getHostDbPath();
  const configPath = expandPath(config);
  if (!existsSync(configPath)) throw new Error(`TIMELINE_CONFIG names ${configPath}, which does not exist`);
  return configuredDbPath(configPath);
}

export function getTimelineDbPath(): string {
  loadEnvFile();
  return process.env.TIMELINE_DB_PATH || DEFAULT_DB_PATH;
}

export interface DbPathInfo {
  resolvedDbPath: string;
  dbParentDir: string;
  noLocalDbMarker: string;
}

export function getDbPathInfo(dbPath: string): DbPathInfo {
  const resolvedDbPath = resolve(dbPath);
  const dbParentDir = dirname(resolvedDbPath);
  const noLocalDbMarker = resolve(dbParentDir, ".no-local-db");

  return { resolvedDbPath, dbParentDir, noLocalDbMarker };
}

export function assertNoLocalDbMarker(info: DbPathInfo, targetPath: string, label: string): void {
  if (existsSync(info.noLocalDbMarker)) {
    throw new Error(
      `Refusing to use ${label} at ${targetPath} - found ${info.noLocalDbMarker}. Set TIMELINE_DB_PATH explicitly.`
    );
  }
}

export function getAppStateDbPath(timelineDbPath: string): string {
  const info = getDbPathInfo(timelineDbPath);
  const appStatePath = join(info.dbParentDir, APP_STATE_DB_FILE);
  assertNoLocalDbMarker(info, appStatePath, "app state database");
  return appStatePath;
}

export function getEmbeddingsDbPath(timelineDbPath: string): string {
  const info = getDbPathInfo(timelineDbPath);
  const embeddingsPath = join(info.dbParentDir, EMBEDDINGS_DB_FILE);
  assertNoLocalDbMarker(info, embeddingsPath, "embeddings database");
  return embeddingsPath;
}

/** Remote agent hosts: Timeline's SSH key, pinned host keys, and pulled mirrors. */
export function getRemoteAgentsDir(timelineDbPath: string): string {
  const info = getDbPathInfo(timelineDbPath);
  const dir = join(info.dbParentDir, "remote-agents");
  assertNoLocalDbMarker(info, dir, "remote agents directory");
  return dir;
}
