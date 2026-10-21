import { Database } from "bun:sqlite";
import { getAppStateDb } from "../db/app-state";
import type { AttachmentDescriptionHistoryPoint } from "../shared/attachments";
import type { SyncLogEntry, SyncResult } from "./types";

/**
 * Clean up orphaned sync log entries from previous runs.
 * Marks any entries with finished_at = NULL as failed (interrupted by restart).
 * Should be called on service startup before starting the scheduler.
 */
export function cleanupOrphanedSyncLogs(db: Database): number {
  const result = db
    .prepare(
      `
    UPDATE sync_log
    SET finished_at = datetime('now'),
        success = 0,
        error = 'Interrupted by service restart'
    WHERE finished_at IS NULL
  `
    )
    .run();

  return result.changes;
}

/**
 * Start a sync log entry.
 * Returns the log entry ID for later completion.
 *
 * Pass `jobId` to link the log row to the queue job that triggered it.
 */
export function startSyncLog(db: Database, source: string, jobId?: number | null): number {
  const result = db.prepare(`
    INSERT INTO sync_log (source, job_id) VALUES (?, ?)
  `).run(source, jobId ?? null);

  return Number(result.lastInsertRowid);
}

/**
 * Complete a sync log entry with the result.
 * Also updates the source column so parsers that auto-detect the type
 * (e.g. google-takeout, auto-detect) can override the initial placeholder.
 */
export function completeSyncLog(
  db: Database,
  logId: number,
  result: SyncResult
): void {
  db.prepare(`
    UPDATE sync_log
    SET source = ?,
        finished_at = datetime('now'),
        success = ?,
        events_added = ?,
        events_updated = ?,
        error = ?,
        duration_ms = ?,
        metadata = ?
    WHERE id = ?
  `).run(
    result.source,
    result.success ? 1 : 0,
    result.eventsAdded,
    result.eventsUpdated,
    result.error ?? null,
    result.durationMs,
    result.metadata ? JSON.stringify(result.metadata) : null,
    logId
  );
}

/**
 * Record a skipped run as a single completed sync_log row.
 *
 * Unlike a normal run there is no start/complete pair: the scheduler decides to
 * skip *before* the work begins, so this writes one finished row directly. A
 * skipped result keeps `success = 1` to avoid a retry and sets `skipped = 1` so
 * `/status` and health can tell it apart from real work.
 */
export function recordSkippedSync(
  db: Database,
  jobId: number | null,
  result: SyncResult
): void {
  db.prepare(`
    INSERT INTO sync_log
      (source, started_at, finished_at, success, skipped, events_added, events_updated, error, duration_ms, metadata, job_id)
    VALUES (?, datetime('now'), datetime('now'), ?, ?, 0, 0, ?, ?, ?, ?)
  `).run(
    result.source,
    result.success ? 1 : 0,
    result.skipped ? 1 : 0,
    result.error ?? null,
    result.durationMs,
    result.metadata ? JSON.stringify(result.metadata) : null,
    jobId
  );
}

/**
 * Get recent sync logs for a source.
 */
export function getRecentSyncLogs(
  db: Database,
  source?: string,
  limit = 10
): SyncLogEntry[] {
  if (source) {
    return db.prepare(`
      SELECT * FROM sync_log
      WHERE source = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(source, limit) as SyncLogEntry[];
  }

  return db.prepare(`
    SELECT * FROM sync_log
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as SyncLogEntry[];
}

/**
 * Aggregate attachment-description runs by UTC day for long-horizon charts.
 * Queue gauges use the final reading of each day while item and run outcomes
 * are summed across the whole day.
 */
export function getAttachmentDescriptionHistory(db: Database): AttachmentDescriptionHistoryPoint[] {
  const rows = db.prepare(`
    WITH parsed AS (
      SELECT
        id,
        finished_at,
        success,
        skipped,
        CASE
          WHEN metadata IS NOT NULL AND json_valid(metadata) THEN metadata
          ELSE '{}'
        END AS metadata_json
      FROM sync_log
      WHERE source = 'attachment-descriptions'
        AND finished_at IS NOT NULL
    ),
    daily AS (
      SELECT
        date(finished_at) AS date,
        COUNT(*) AS runs,
        SUM(CASE WHEN success = 0 AND skipped = 0 THEN 1 ELSE 0 END) AS failedRuns,
        SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) AS deferredRuns,
        SUM(CASE
          WHEN json_type(metadata_json, '$.described') = 'integer'
            AND json_extract(metadata_json, '$.described') >= 0
          THEN json_extract(metadata_json, '$.described')
          ELSE 0
        END) AS described,
        SUM(CASE
          WHEN json_type(metadata_json, '$.skipped') = 'integer'
            AND json_extract(metadata_json, '$.skipped') >= 0
          THEN json_extract(metadata_json, '$.skipped')
          ELSE 0
        END) AS itemSkipped,
        SUM(CASE
          WHEN json_type(metadata_json, '$.failed') = 'integer'
            AND json_extract(metadata_json, '$.failed') >= 0
          THEN json_extract(metadata_json, '$.failed')
          ELSE 0
        END) AS failed
      FROM parsed
      GROUP BY date(finished_at)
    ),
    readings AS (
      SELECT
        date(finished_at) AS date,
        CAST(json_extract(metadata_json, '$.remainingQueueDepth') AS INTEGER) AS queueDepth,
        CASE
          WHEN json_type(metadata_json, '$.descriptionEligibleHashes') = 'integer'
            AND json_extract(metadata_json, '$.descriptionEligibleHashes') >= 0
          THEN CAST(json_extract(metadata_json, '$.descriptionEligibleHashes') AS INTEGER)
        END AS descriptionEligibleHashes,
        CASE
          WHEN json_type(metadata_json, '$.describedHashes') = 'integer'
            AND json_extract(metadata_json, '$.describedHashes') >= 0
          THEN CAST(json_extract(metadata_json, '$.describedHashes') AS INTEGER)
        END AS describedHashes,
        ROW_NUMBER() OVER (
          PARTITION BY date(finished_at)
          ORDER BY finished_at DESC, id DESC
        ) AS readingRank
      FROM parsed
      WHERE json_type(metadata_json, '$.remainingQueueDepth') = 'integer'
        AND json_extract(metadata_json, '$.remainingQueueDepth') >= 0
    )
    SELECT
      daily.date,
      readings.queueDepth,
      readings.descriptionEligibleHashes,
      readings.describedHashes,
      daily.described,
      daily.itemSkipped AS skipped,
      daily.failed,
      daily.runs,
      daily.failedRuns,
      daily.deferredRuns
    FROM daily
    LEFT JOIN readings
      ON readings.date = daily.date AND readings.readingRank = 1
    ORDER BY daily.date ASC
  `).all() as AttachmentDescriptionHistoryPoint[];

  return rows.map((row) => {
    const coverageIsValid = row.descriptionEligibleHashes !== null &&
      row.describedHashes !== null &&
      row.describedHashes <= row.descriptionEligibleHashes;
    return coverageIsValid
      ? row
      : { ...row, descriptionEligibleHashes: null, describedHashes: null };
  });
}

/**
 * Get the last successful sync for a source.
 */
export function getLastSuccessfulSync(
  db: Database,
  source: string
): SyncLogEntry | null {
  return db.prepare(`
    SELECT * FROM sync_log
    WHERE source = ? AND success = 1
    ORDER BY started_at DESC
    LIMIT 1
  `).get(source) as SyncLogEntry | null;
}

/**
 * Format a sync result for console output.
 */
export function formatSyncResult(result: SyncResult): string {
  const duration = `${(result.durationMs / 1000).toFixed(1)}s`;

  if (result.skipped) {
    const reason = (result.metadata?.skipReason as string | undefined) ?? "guard deferred";
    return `\x1b[33m⤼\x1b[0m ${result.source}: deferred — ${reason} (${duration})`;
  }

  const status = result.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";

  if (result.success) {
    // Handle backup sources with metadata
    if ((result.source === "backup" || result.source === "backup-app-state") && result.metadata) {
      const sizeMB = result.metadata.sizeMB as number | undefined;
      const deleted = result.metadata.deleted as number | undefined;
      const parts: string[] = [];
      if (sizeMB !== undefined) {
        parts.push(sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`);
      }
      if (deleted) {
        parts.push(`${deleted} deleted`);
      }
      const info = parts.length > 0 ? parts.join(", ") : "backup complete";
      return `${status} ${result.source}: ${info} (${duration})`;
    }

    const added = result.eventsAdded > 0 ? `+${result.eventsAdded}` : "0";
    const updated = result.eventsUpdated > 0 ? `~${result.eventsUpdated}` : "";
    const events = updated ? `${added}, ${updated}` : added;
    return `${status} ${result.source}: ${events} events (${duration})`;
  } else {
    return `${status} ${result.source}: ${result.error} (${duration})`;
  }
}
