import { existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { loadEnvFile } from "../config";

const DEFAULT_DB_PATH = "./timeline.db";

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
