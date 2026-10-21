/**
 * Job queue types
 *
 * A job represents a durable "do this" request — sync a source, process an
 * inbox folder, etc. Jobs are written to app-state.db and consumed by the
 * job runner in the scheduler worker thread.
 */

export type JobKind = "sync" | "inbox-process";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobTrigger = "manual" | "scheduler" | "inbox-watcher" | "upload";

export interface JobRow {
  id: number;
  kind: string;
  source: string | null;
  payload: string;
  dedupe_key: string | null;
  status: JobStatus;
  priority: number;
  attempt: number;
  max_attempts: number;
  enqueued_at: string;
  not_before: string;
  started_at: string | null;
  finished_at: string | null;
  worker_id: string | null;
  worker_lease_until: string | null;
  result: string | null;
  error: string | null;
  trigger: string;
}

export interface Job {
  id: number;
  kind: JobKind;
  source: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  status: JobStatus;
  priority: number;
  attempt: number;
  maxAttempts: number;
  enqueuedAt: string;
  notBefore: string;
  startedAt: string | null;
  finishedAt: string | null;
  workerId: string | null;
  workerLeaseUntil: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  trigger: JobTrigger;
}

export interface EnqueueRequest {
  kind: JobKind;
  source?: string | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  trigger?: JobTrigger;
  /** Claim-order priority (higher claimed first). Defaults to a per-trigger value; see TRIGGER_PRIORITY. */
  priority?: number;
  maxAttempts?: number;
  notBefore?: Date | string | null;
}

export interface EnqueueOutcome {
  jobId: number;
  /** True if an existing queued job was returned instead of inserting a new one. */
  deduped: boolean;
}
