import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { parse as parseTOML } from "@iarna/toml";
import { expandPath, loadEnvFile } from "../config";

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
  let parsed: { database?: { path?: unknown } };
  try {
    parsed = parseTOML(readFileSync(HOST_CONFIG_PATH, "utf8")) as typeof parsed;
  } catch (err) {
    throw new Error(`Could not read ${HOST_CONFIG_PATH}: ${(err as Error).message}`);
  }
  const path = parsed.database?.path;
  if (path === undefined) return DEFAULT_HOST_DB_PATH;
  if (typeof path !== "string") throw new Error(`[database].path in ${HOST_CONFIG_PATH} must be a string`);
  return expandPath(path);
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
  const appStatePath = join(info.dbParentDir, "app-state.db");
  assertNoLocalDbMarker(info, appStatePath, "app state database");
  return appStatePath;
}

export function getEmbeddingsDbPath(timelineDbPath: string): string {
  const info = getDbPathInfo(timelineDbPath);
  const embeddingsPath = join(info.dbParentDir, "embeddings.db");
  assertNoLocalDbMarker(info, embeddingsPath, "embeddings database");
  return embeddingsPath;
}
