/**
 * Recall (MacBook screen capture) parser.
 *
 * Walks recall inbox directories laid out as either:
 *   <root>/<host>/<YYYY-MM-DD>/<HHMMSS>.webp
 *   <root>/<host>/<YYYY-MM-DD>/<HHMMSS>.json   (sidecar emitted by tools/timeline-recall + capture.sh)
 * or, for captures written directly by the local menu bar app:
 *   <root>/<YYYY-MM-DD>/<HHMMSS>.{webp,json}
 *
 * For each webp+json pair:
 *   1. Store the image via the content-addressed media store (dedup on hash).
 *   2. Insert an event with OCR text in `content` (FTS5-indexed).
 *   3. Insert an attachment row pointing at the stored file.
 *   4. Delete the source pair (the by-hash copy persists in the media root).
 */
import { Database } from "bun:sqlite";
import { readdir, unlink } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { onImportComplete } from "../db/import-hooks";
import { getDb, initDb } from "../db/schema";
import { insertStoredAttachment } from "../media/attachments";
import { storeFile } from "../media/storage";

const DEFAULT_RECALL_DIR = join(homedir(), ".local", "share", "timeline", "recall");

interface RecallSidecar {
  captured_at: string;       // ISO 8601 UTC
  hostname: string;
  frontmost_app?: string;    // legacy whole-screen captures (pre per-window)
  app?: string;              // owning app of this window
  bundle_id?: string;        // owning app's bundle identifier (stable id)
  window_title?: string;
  is_frontmost?: boolean;    // true if this window's app was frontmost at capture
  window_id?: number;
  window_index?: number;
  ocr_text?: string;
  ocr_line_count?: number;
  width?: number;            // captured image, pixels
  height?: number;
  point_pixel_scale?: number; // display backing scale used to size the capture
  // Ephemeral spatial state, preserved for future screen reconstruction. Stored
  // in raw_data only (not promoted to columns). frame/display_frame are screen
  // points (global coords); point_pixel_scale is the backing scale.
  schema_version?: number;
  frame?: { x: number; y: number; w: number; h: number };
  window_layer?: number;     // z-order
  display_id?: number;
  display_frame?: { x: number; y: number; w: number; h: number };
}

export interface ImportRecallStats {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
  deduplicated: number;
}

export interface ImportRecallOptions {
  maxCaptures?: number;
}

interface RecallCaptureDir {
  date: string;
  path: string;
  host: string | null;
}

const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function importRecall(
  db: Database,
  rootDir: string,
  options: ImportRecallOptions = {}
): Promise<ImportRecallStats> {
  const maxCaptures = options.maxCaptures ?? Number.POSITIVE_INFINITY;
  const importBatch = `recall-${Date.now()}`;
  const stats: ImportRecallStats = {
    scanned: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    deduplicated: 0,
  };

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const findEventId = db.prepare(`
    SELECT id FROM events
    WHERE source = 'recall' AND source_id = ? AND source_account = ?
  `);

  let rootEntries: string[];
  try {
    rootEntries = await readdir(rootDir);
  } catch {
    return stats;
  }

  const captureDirs: RecallCaptureDir[] = [];
  for (const entry of rootEntries) {
    if (DATE_DIR_PATTERN.test(entry)) {
      captureDirs.push({ date: entry, path: join(rootDir, entry), host: null });
      continue;
    }

    const hostDir = join(rootDir, entry);
    let dates: string[];
    try {
      dates = await readdir(hostDir);
    } catch {
      continue;
    }

    for (const date of dates.filter((candidate) => DATE_DIR_PATTERN.test(candidate))) {
      captureDirs.push({ date, path: join(hostDir, date), host: entry });
    }
  }

  for (const captureDir of captureDirs) {
    if (stats.scanned >= maxCaptures) break;

    let files: string[];
    try {
      files = await readdir(captureDir.path);
    } catch {
      continue;
    }

    const webpFiles = files.filter((f) => f.endsWith(".webp"));

    for (const webpFile of webpFiles) {
      if (stats.scanned >= maxCaptures) break;

      stats.scanned++;
      const stamp = webpFile.slice(0, -".webp".length);
      const webpPath = join(captureDir.path, webpFile);
      const jsonPath = join(captureDir.path, `${stamp}.json`);

      let sidecar: RecallSidecar;
      try {
        sidecar = JSON.parse(await Bun.file(jsonPath).text());
      } catch {
        // Sidecar missing or invalid — skip; capture.sh writes atomically,
        // so a missing sidecar means an interrupted upload. Try again next run.
        stats.skipped++;
        continue;
      }

      const host = captureDir.host ?? sidecar.hostname;
      if (!sidecar.captured_at || !host) {
        stats.skipped++;
        continue;
      }
      const sourceId = `${host}:${captureDir.date}:${stamp}`;

      try {
        const content = await Bun.file(webpPath).bytes();
        const stored = await storeFile({
          source: "recall",
          relativePath: join(host, captureDir.date, webpFile),
          content,
        });
        if (stored.deduplicated) stats.deduplicated++;

        const rawData = JSON.stringify({
          ...sidecar,
          content_hash: stored.hash,
          deduplicated: stored.deduplicated,
        });

        // Title is the window's app name (per-window since v1); fall back to
        // frontmost_app for legacy whole-screen captures still draining.
        const title = sidecar.app ?? sidecar.frontmost_app ?? null;

        const result = insertEvent.run(
          "recall",
          sourceId,
          host,
          "screen:capture",
          sidecar.captured_at,
          title,
          sidecar.ocr_text ?? null,
          rawData,
          importBatch
        );

        const eventRow = findEventId.get(sourceId, host) as
          | { id: number }
          | undefined;
        if (!eventRow) {
          // Should never happen — INSERT OR IGNORE with no existing row
          // would have inserted, and an existing row is what we'd find.
          stats.failed++;
          continue;
        }

        insertStoredAttachment(
          db,
          {
            eventId: eventRow.id,
            source: "recall",
            sourceId,
            filename: webpFile,
            mimeType: "image/webp",
            width: sidecar.width ?? null,
            height: sidecar.height ?? null,
          },
          stored
        );

        if (result.changes > 0) {
          stats.imported++;
        } else {
          stats.skipped++;
        }
      } catch (e) {
        console.error(`recall: failed ${webpPath}:`, e);
        stats.failed++;
        continue;
      }

      // Cleanup is intentionally outside the import try/catch so an unlink
      // failure does NOT also bump stats.failed (which would double-count
      // an already-imported entry). The content-addressed copy under
      // media/by-hash persists; storage_path is a hardlink, so the
      // attachment row remains valid. If unlink fails here, the next run
      // re-encounters the file — UNIQUE constraint makes the re-import a
      // no-op and we get another chance to clean up.
      try {
        await unlink(webpPath);
        await unlink(jsonPath).catch(() => {
          // sidecar already missing — fine
        });
      } catch (e) {
        console.error(`recall: cleanup failed for ${webpPath}:`, e);
      }
    }
  }

  if (stats.imported > 0 || stats.deduplicated > 0) {
    onImportComplete(db);
  }

  return stats;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootDir = args[0] ?? DEFAULT_RECALL_DIR;

  console.log(`Importing recall captures from ${rootDir}`);
  const db = getDb();
  initDb(db);
  const stats = await importRecall(db, rootDir);
  db.close();

  console.log(`\n${"=".repeat(50)}`);
  console.log("Recall import complete:");
  console.log(`  Scanned:      ${stats.scanned}`);
  console.log(`  Imported:     ${stats.imported}`);
  console.log(`  Deduplicated: ${stats.deduplicated}`);
  console.log(`  Skipped:      ${stats.skipped}`);
  console.log(`  Failed:       ${stats.failed}`);
}
