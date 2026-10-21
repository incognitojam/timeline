import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import * as sqliteVec from "sqlite-vec";

let configuredSqliteLibraryPath: string | null = null;

export function configureBunSqliteForSqliteVec(): void {
  const libraryPath = process.env.TIMELINE_SQLITE_LIBRARY_PATH;
  if (!libraryPath) return;
  if (configuredSqliteLibraryPath === libraryPath) return;
  // The library is chosen once per process: workers share the main thread's
  // and fail with "SQLite already loaded" if they try to choose again.
  if (!isMainThread) return;
  if (!existsSync(libraryPath)) {
    throw new Error(`Failed to load TIMELINE_SQLITE_LIBRARY_PATH for sqlite-vec (${libraryPath}): file does not exist`);
  }

  try {
    Database.setCustomSQLite(libraryPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load TIMELINE_SQLITE_LIBRARY_PATH for sqlite-vec (${libraryPath}): ${message}`);
  }
  configuredSqliteLibraryPath = libraryPath;
}

export function loadSqliteVec(db: Database): void {
  try {
    sqliteVec.load(db);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sqlite-vec is unavailable: ${message}`);
  }
}

export function serializeVector(vector: number[]): Float32Array {
  return new Float32Array(vector);
}
