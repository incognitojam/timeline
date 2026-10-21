/**
 * Job store
 *
 * SQL helpers around the `jobs` table in app-state.db. Multi-process safe via
 * SQLite IMMEDIATE transactions + the partial unique index on
 * (kind, dedupe_key) where status = 'queued'.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getAppStateDb } from "../db/app-state";
import type {
  EnqueueOutcome,
  EnqueueRequest,
  Job,
  JobKind,
  JobRow,
  JobStatus,
  JobTrigger,
} from "./types";

const ACTIVE_STATUSES: JobStatus[] = ["queued", "running"];

// A follow-up may have taken the queued dedupe slot while this job was
// running. Preserve both requests (including their IDs and payloads), but
// leave new enqueues deduping onto the follow-up. Evaluate inside the UPDATE
// so another connection cannot enqueue between the conflict check and requeue.
const REQUEUE_DEDUPE_KEY = `CASE WHEN EXISTS (
  SELECT 1 FROM jobs AS queued
  WHERE queued.status = 'queued'
    AND queued.kind = jobs.kind
    AND queued.dedupe_key = jobs.dedupe_key
    AND queued.id != jobs.id
) THEN NULL ELSE dedupe_key END`;

/**
 * Default claim-order priority by trigger, applied when an enqueue doesn't set
 * `priority` explicitly. Higher is claimed first (claimNextJob orders by
 * `priority DESC, id ASC`).
 *
 * Human-initiated work — a dashboard "run now" (`manual`) or an uploaded file
 * (`upload`) — outranks background `scheduler`/`inbox-watcher` work so someone
 * waiting at the dashboard isn't stuck behind a long routine sync. Backups run
 * on the `scheduler` trigger and stay at the background tier: they are not
 * deprioritized, so a due backup still drains in FIFO order alongside other
 * scheduled jobs, and is only ever jumped by a (bursty, rare) human action.
 */
export const TRIGGER_PRIORITY: Record<JobTrigger, number> = {
  manual: 10,
  upload: 10,
  scheduler: 0,
  "inbox-watcher": 0,
};

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    source: row.source,
    payload: parseJson(row.payload, {}),
    dedupeKey: row.dedupe_key,
    status: row.status,
    priority: row.priority,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    enqueuedAt: row.enqueued_at,
    notBefore: row.not_before,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    workerId: row.worker_id,
    workerLeaseUntil: row.worker_lease_until,
    result: row.result ? parseJson(row.result, null) : null,
    error: row.error,
    trigger: row.trigger as JobTrigger,
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toSqliteTimestamp(input: Date | string): string {
  const date = input instanceof Date ? input : new Date(input);
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export function enqueueJob(req: EnqueueRequest, db: Database = getAppStateDb()): EnqueueOutcome {
  const payload = JSON.stringify(req.payload ?? {});
  const trigger: JobTrigger = req.trigger ?? "manual";
  const priority = req.priority ?? TRIGGER_PRIORITY[trigger];
  const maxAttempts = req.maxAttempts ?? 1;
  const notBefore = req.notBefore ? toSqliteTimestamp(req.notBefore) : null;

  // INSERT + SELECT must be atomic: without the IMMEDIATE write lock, the
  // runner could claim the conflicting `queued` row in another connection
  // between our INSERT and SELECT, and the SELECT (filtered to `queued`)
  // would come back empty even though we just hit a conflict.
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(`
      INSERT INTO jobs (kind, source, payload, dedupe_key, priority, max_attempts, not_before, trigger)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
      ON CONFLICT DO NOTHING
      RETURNING id
    `);

    const inserted = insert.get(
      req.kind,
      req.source ?? null,
      payload,
      req.dedupeKey ?? null,
      priority,
      maxAttempts,
      notBefore,
      trigger
    ) as { id: number } | null;

    if (inserted) {
      db.exec("COMMIT");
      return { jobId: inserted.id, deduped: false };
    }

    // Conflict — there must be a queued row with this dedupe_key
    // (the partial unique index only fires for status='queued' rows, and the
    // write lock prevents anyone from transitioning it underneath us).
    if (!req.dedupeKey) {
      throw new Error("enqueueJob: insert failed but no dedupe_key was set");
    }

    // Escalate the existing row to the higher priority so a later manual/upload
    // request lifts an already-queued background job ahead of other background
    // work (the case the per-trigger default targets — without this, the bump is
    // dropped whenever the request dedupes). MAX only ever raises: a queued
    // manual job keeps its priority when a scheduler enqueue dedupes onto it.
    // The unique index guarantees at most one queued row per (kind, dedupe_key),
    // so the UPDATE touches exactly that row.
    const existing = db
      .prepare(
        `UPDATE jobs
         SET priority = MAX(priority, ?)
         WHERE kind = ? AND dedupe_key = ? AND status = 'queued'
         RETURNING id`
      )
      .get(priority, req.kind, req.dedupeKey) as { id: number } | null;

    if (!existing) {
      throw new Error(
        `enqueueJob: dedupe conflict for ${req.kind}/${req.dedupeKey} but no queued row found`
      );
    }
    db.exec("COMMIT");
    return { jobId: existing.id, deduped: true };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

export function getJob(id: number, db: Database = getAppStateDb()): Job | null {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | null;
  return row ? rowToJob(row) : null;
}

export interface ListJobsOptions {
  status?: JobStatus | JobStatus[];
  source?: string;
  kind?: JobKind;
  limit?: number;
  offset?: number;
}

export function listJobs(options: ListJobsOptions = {}, db: Database = getAppStateDb()): Job[] {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (options.source) {
    where.push("source = ?");
    params.push(options.source);
  }
  if (options.kind) {
    where.push("kind = ?");
    params.push(options.kind);
  }

  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const offset = Math.max(0, options.offset ?? 0);

  const sql = `
    SELECT * FROM jobs
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(sql).all(...params, limit, offset) as JobRow[];
  return rows.map(rowToJob);
}

export function countActiveJobs(
  options: { kind?: JobKind; source?: string } = {},
  db: Database = getAppStateDb()
): number {
  const where: string[] = ["status IN ('queued','running')"];
  const params: SQLQueryBindings[] = [];
  if (options.kind) {
    where.push("kind = ?");
    params.push(options.kind);
  }
  if (options.source) {
    where.push("source = ?");
    params.push(options.source);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${where.join(" AND ")}`)
    .get(...params) as { n: number };
  return row.n;
}

export interface ClaimOptions {
  workerId: string;
  leaseMs: number;
  kinds?: JobKind[];
  syncSource?: string;
  excludeSyncSource?: string;
}

/**
 * Atomically claim the next runnable job. Returns the claimed Job (status='running')
 * or null if nothing is ready.
 */
export function claimNextJob(opts: ClaimOptions, db: Database = getAppStateDb()): Job | null {
  const kindFilter = opts.kinds && opts.kinds.length > 0
    ? `AND kind IN (${opts.kinds.map(() => "?").join(",")})`
    : "";
  const params: SQLQueryBindings[] = [...(opts.kinds ?? [])];
  const sourceFilters: string[] = [];
  if (opts.syncSource !== undefined) {
    sourceFilters.push("AND kind = 'sync' AND source = ?");
    params.push(opts.syncSource);
  }
  if (opts.excludeSyncSource !== undefined) {
    sourceFilters.push("AND NOT (kind = 'sync' AND source IS ?)");
    params.push(opts.excludeSyncSource);
  }

  const leaseUntil = toSqliteTimestamp(new Date(Date.now() + opts.leaseMs));
  const selectCandidate = db.prepare(`
    SELECT id FROM jobs
    WHERE status = 'queued' AND not_before <= datetime('now')
    ${kindFilter}
    ${sourceFilters.join(" ")}
    ORDER BY priority DESC, id ASC
    LIMIT 1
  `);

  // Idle polls need no write lock. Recheck after acquiring it: another runner
  // may have claimed the candidate between this read and BEGIN IMMEDIATE.
  if (!selectCandidate.get(...params)) return null;

  // BEGIN IMMEDIATE acquires a write lock so another process can't claim the
  // same row between our SELECT and UPDATE.
  db.exec("BEGIN IMMEDIATE");
  try {
    const candidate = selectCandidate.get(...params) as { id: number } | null;

    if (!candidate) {
      db.exec("COMMIT");
      return null;
    }

    const updated = db
      .prepare(
        `UPDATE jobs
         SET status = 'running',
             started_at = COALESCE(started_at, datetime('now')),
             worker_id = ?,
             worker_lease_until = ?,
             attempt = attempt + 1
         WHERE id = ? AND status = 'queued'
         RETURNING *`
      )
      .get(opts.workerId, leaseUntil, candidate.id) as JobRow | null;

    db.exec("COMMIT");
    return updated ? rowToJob(updated) : null;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

export function completeJob(
  id: number,
  result: Record<string, unknown> | null,
  db: Database = getAppStateDb()
): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'succeeded',
         finished_at = datetime('now'),
         worker_lease_until = NULL,
         result = ?,
         error = NULL
     WHERE id = ?`
  ).run(result ? JSON.stringify(result) : null, id);
}

export interface FailOptions {
  retry?: boolean;
  backoffMs?: number;
}

export function failJob(
  id: number,
  error: string,
  options: FailOptions = {},
  db: Database = getAppStateDb()
): void {
  const row = db
    .prepare(`SELECT attempt, max_attempts FROM jobs WHERE id = ?`)
    .get(id) as { attempt: number; max_attempts: number } | null;
  if (!row) return;

  const canRetry = options.retry === true && row.attempt < row.max_attempts;

  if (canRetry) {
    const backoffMs = options.backoffMs ?? 0;
    const nextNotBefore = toSqliteTimestamp(new Date(Date.now() + backoffMs));
    db.prepare(
      `UPDATE jobs
       SET status = 'queued',
           dedupe_key = ${REQUEUE_DEDUPE_KEY},
           started_at = NULL,
           worker_id = NULL,
           worker_lease_until = NULL,
           not_before = ?,
           error = ?
       WHERE id = ?`
    ).run(nextNotBefore, error, id);
  } else {
    db.prepare(
      `UPDATE jobs
       SET status = 'failed',
           finished_at = datetime('now'),
           worker_lease_until = NULL,
           error = ?
       WHERE id = ?`
    ).run(error, id);
  }
}

/**
 * Return an in-flight job to `queued` without counting the interruption as a
 * failed attempt.
 *
 * Called when the runner is stopped gracefully (e.g. a deploy) while a handler
 * is still running: the job was *preempted*, not failed, so it should resume on
 * the next boot rather than be recorded as `failed`. The claim's `attempt`
 * increment is undone (`attempt - 1`) so the preemption doesn't consume the
 * retry budget — this is the distinction from `failJob({ retry })`, which gates
 * on `attempt < max_attempts` and so cannot requeue the default `maxAttempts = 1`
 * job at all.
 *
 * Guarded on `status = 'running'`: requeue moves a job *backward* in its
 * lifecycle, so it must never resurrect a row that already reached a terminal
 * state (e.g. a job that completed in the instant before interruption).
 */
export function requeueJob(id: number, reason: string, db: Database = getAppStateDb()): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'queued',
         dedupe_key = ${REQUEUE_DEDUPE_KEY},
         started_at = NULL,
         worker_id = NULL,
         worker_lease_until = NULL,
         attempt = MAX(attempt - 1, 0),
         error = ?
     WHERE id = ? AND status = 'running'`
  ).run(reason, id);
}

export function cancelJob(id: number, db: Database = getAppStateDb()): boolean {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'cancelled',
           finished_at = datetime('now'),
           worker_lease_until = NULL
       WHERE id = ? AND status = 'queued'`
    )
    .run(id);
  return result.changes > 0;
}

/**
 * Reclaim jobs whose lease expired (worker died mid-job).
 *
 * Jobs with attempts remaining are returned to 'queued'; jobs that have
 * exhausted their attempts are marked 'failed'.
 *
 * `excludeWorkerId` skips rows currently leased to that worker. A live worker
 * passes its own id so it never reclaims a job it is actively running — lease
 * expiry is a heuristic for "the worker is gone", but a worker knows it is not
 * gone. Without this, a handler that outruns its lease would have its own
 * in-flight row requeued/failed (and the later complete/fail would clobber the
 * reclaimed state). Startup cleanup passes null to reclaim everything.
 *
 * Returns the count of rows touched.
 */
export function reclaimExpiredLeases(
  excludeWorkerId: string | null = null,
  db: Database = getAppStateDb()
): number {
  // `worker_id IS NOT ?` is null-safe: with a null param it reduces to
  // `worker_id IS NOT NULL`, which is true for every running row (they all
  // hold a worker_id), so nothing is excluded.
  const requeued = db
    .prepare(
      `UPDATE jobs
       SET status = 'queued',
           dedupe_key = ${REQUEUE_DEDUPE_KEY},
           worker_id = NULL,
           worker_lease_until = NULL,
           started_at = NULL,
           error = COALESCE(error, 'Worker lease expired (worker crashed or stalled)')
       WHERE status = 'running'
         AND worker_lease_until IS NOT NULL
         AND worker_lease_until < datetime('now')
         AND attempt < max_attempts
         AND worker_id IS NOT ?`
    )
    .run(excludeWorkerId);

  const failed = db
    .prepare(
      `UPDATE jobs
       SET status = 'failed',
           finished_at = datetime('now'),
           worker_lease_until = NULL,
           error = COALESCE(error, 'Worker lease expired and max attempts reached')
       WHERE status = 'running'
         AND worker_lease_until IS NOT NULL
         AND worker_lease_until < datetime('now')
         AND attempt >= max_attempts
         AND worker_id IS NOT ?`
    )
    .run(excludeWorkerId);

  return requeued.changes + failed.changes;
}

/**
 * Mark all 'running' jobs as failed. Called at service startup so a crash
 * doesn't leave perpetually-running rows for jobs whose worker is gone.
 *
 * Single-worker assumption: if the service is starting, no other worker
 * is holding any leases. Multi-worker deployments should rely on
 * reclaimExpiredLeases instead.
 */
export function failAllRunningJobs(db: Database = getAppStateDb()): number {
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'failed',
           finished_at = datetime('now'),
           worker_lease_until = NULL,
           error = COALESCE(error, 'Interrupted by service restart')
       WHERE status = 'running'`
    )
    .run();
  return result.changes;
}
