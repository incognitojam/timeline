/**
 * Processed File Tracker
 *
 * Tracks which files have been processed to avoid re-importing the same data.
 * Uses file hash for deduplication. Data stored in app-state.db.
 */

import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { stat } from "fs/promises";
import { getAppStateDb } from "../db/app-state";

export interface ProcessedFile {
  id: number;
  source: string;
  file_path: string;
  file_hash: string;
  file_size: number;
  processed_at: string;
  import_batch: string | null;
  detected_type: string | null;
  events_added: number | null;
}

/**
 * Get the tracker database (app-state.db)
 */
export function getTrackerDb(): Database {
  return getAppStateDb();
}

/**
 * Calculate SHA-256 hash of a file
 */
export async function hashFile(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hash = createHash("sha256");
  hash.update(Buffer.from(buffer));
  return hash.digest("hex");
}

/**
 * Check if a file has already been processed (by hash)
 */
export function isFileProcessed(db: Database, source: string, fileHash: string): boolean {
  const result = db
    .prepare("SELECT 1 FROM processed_files WHERE source = ? AND file_hash = ?")
    .get(source, fileHash);
  return result !== null;
}

/**
 * Check if a file path was previously processed (may have different hash now)
 */
export function getProcessedByPath(
  db: Database,
  source: string,
  filePath: string
): ProcessedFile | null {
  return db
    .prepare("SELECT * FROM processed_files WHERE source = ? AND file_path = ?")
    .get(source, filePath) as ProcessedFile | null;
}

/**
 * Mark a file as processed
 */
export function markFileProcessed(
  db: Database,
  source: string,
  filePath: string,
  fileHash: string,
  fileSize: number,
  importBatch?: string,
  detectedType?: string,
  eventsAdded?: number
): void {
  db.prepare(`
    INSERT INTO processed_files (source, file_path, file_hash, file_size, import_batch, detected_type, events_added)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, file_hash) DO UPDATE SET
      file_path = excluded.file_path,
      processed_at = datetime('now'),
      import_batch = excluded.import_batch,
      detected_type = excluded.detected_type,
      events_added = excluded.events_added
  `).run(source, filePath, fileHash, fileSize, importBatch ?? null, detectedType ?? null, eventsAdded ?? null);
}

/**
 * Get all processed files for a source
 */
export function getProcessedFiles(db: Database, source: string): ProcessedFile[] {
  return db
    .prepare("SELECT * FROM processed_files WHERE source = ? ORDER BY processed_at DESC")
    .all(source) as ProcessedFile[];
}

/**
 * Get processing statistics for a source
 */
export function getSourceStats(db: Database, source: string): {
  totalFiles: number;
  totalSize: number;
  lastProcessed: string | null;
} {
  const result = db
    .prepare(`
      SELECT
        COUNT(*) as total_files,
        COALESCE(SUM(file_size), 0) as total_size,
        MAX(processed_at) as last_processed
      FROM processed_files
      WHERE source = ?
    `)
    .get(source) as { total_files: number; total_size: number; last_processed: string | null };

  return {
    totalFiles: result.total_files,
    totalSize: result.total_size,
    lastProcessed: result.last_processed,
  };
}

/**
 * Clear all processed records for a source (for re-import)
 */
export function clearSource(db: Database, source: string): number {
  const result = db.prepare("DELETE FROM processed_files WHERE source = ?").run(source);
  return result.changes;
}

/**
 * Scan a directory and return files that haven't been processed yet
 */
export async function findUnprocessedFiles(
  db: Database,
  source: string,
  directory: string,
  patterns: string[] = ["*"]
): Promise<Array<{ path: string; hash: string; size: number }>> {
  const { Glob } = await import("bun");
  const { basename } = await import("path");

  const unprocessed: Array<{ path: string; hash: string; size: number }> = [];

  for (const pattern of patterns) {
    const glob = new Glob(pattern);

    for await (const file of glob.scan({ cwd: directory, absolute: true })) {
      try {
        const fileStats = await stat(file);
        if (!fileStats.isFile()) continue;

        const hash = await hashFile(file);

        if (!isFileProcessed(db, source, hash)) {
          unprocessed.push({
            path: file,
            hash,
            size: fileStats.size,
          });
        }
      } catch (error) {
        console.warn(`Warning: Could not process ${file}:`, error);
      }
    }
  }

  // Sort by filename for consistent ordering
  unprocessed.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));

  return unprocessed;
}
