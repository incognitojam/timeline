/**
 * Job store tests
 *
 * Exercises enqueue/claim/complete/fail/reclaim against a fresh in-memory-style
 * SQLite database initialized with the same schema as app-state.db.
 */

import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { initAppStateDb } from "../db/app-state";
import {
  cancelJob,
  claimNextJob,
  completeJob,
  countActiveJobs,
  enqueueJob,
  failAllRunningJobs,
  failJob,
  getJob,
  listJobs,
  reclaimExpiredLeases,
  requeueJob,
} from "./store";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA foreign_keys = ON");
  initAppStateDb(db);
  return db;
}

describe("jobs/store", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  test("idle filtered claims are read-only and pick up newly enqueued work", () => {
    const exec = spyOn(db, "exec");
    const options = { workerId: "worker", leaseMs: 60_000, syncSource: "vision" };
    try {
      enqueueJob({ kind: "inbox-process", source: "example" }, db);
      enqueueJob({ kind: "sync", source: "vision", notBefore: new Date(Date.now() + 60_000) }, db);
      exec.mockClear();
      for (let poll = 0; poll < 10; poll++) expect(claimNextJob(options, db)).toBeNull();
      expect(exec).not.toHaveBeenCalled();
      const ready = enqueueJob({ kind: "sync", source: "vision" }, db);
      exec.mockClear();
      expect(claimNextJob(options, db)?.id).toBe(ready.jobId);
      expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    } finally {
      exec.mockRestore();
    }
  });

  test("claim rechecks a candidate lost between the idle read and write lock", () => {
    const queued = enqueueJob({ kind: "sync", source: "example" }, db);
    const originalExec = db.exec.bind(db);
    const exec = spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN IMMEDIATE") {
        db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(queued.jobId);
      }
      return originalExec(sql);
    });
    try {
      expect(claimNextJob({ workerId: "worker", leaseMs: 60_000 }, db)).toBeNull();
      expect(getJob(queued.jobId, db)?.status).toBe("cancelled");
      expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    } finally {
      exec.mockRestore();
    }
  });

  test("enqueueJob inserts and getJob returns it", () => {
    const { jobId, deduped } = enqueueJob(
      { kind: "sync", source: "foo", dedupeKey: "sync:foo", trigger: "manual" },
      db
    );
    expect(deduped).toBe(false);
    const job = getJob(jobId, db);
    expect(job).not.toBeNull();
    expect(job?.kind).toBe("sync");
    expect(job?.source).toBe("foo");
    expect(job?.status).toBe("queued");
    expect(job?.trigger).toBe("manual");
    expect(job?.attempt).toBe(0);
  });

  test("dedupe collapses concurrent queued enqueues for the same key", () => {
    const a = enqueueJob({ kind: "sync", source: "foo", dedupeKey: "sync:foo" }, db);
    const b = enqueueJob({ kind: "sync", source: "foo", dedupeKey: "sync:foo" }, db);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.jobId).toBe(a.jobId);

    // After completion, dedupe key no longer matches any queued row.
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    completeJob(a.jobId, { ok: true }, db);
    const c = enqueueJob({ kind: "sync", source: "foo", dedupeKey: "sync:foo" }, db);
    expect(c.deduped).toBe(false);
    expect(c.jobId).not.toBe(a.jobId);
  });

  test("enqueue is atomic across INSERT+SELECT", () => {
    // Models the cross-connection race the IMMEDIATE wrap is supposed to fix:
    // an outside writer transitions the queued row mid-call. Inside our
    // transaction the row's status is fixed, so the SELECT must still find
    // it instead of throwing.
    const a = enqueueJob({ kind: "sync", source: "foo", dedupeKey: "sync:foo" }, db);

    // Simulate another connection trying to enqueue the same dedupe_key while
    // a `queued` row exists — should return the existing row's id, not throw.
    const b = enqueueJob({ kind: "sync", source: "foo", dedupeKey: "sync:foo" }, db);
    expect(b.deduped).toBe(true);
    expect(b.jobId).toBe(a.jobId);

    // After claim, the row is `running` — a new enqueue must succeed
    // (no queued row to dedupe against).
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    const c = enqueueJob({ kind: "sync", source: "foo", dedupeKey: "sync:foo" }, db);
    expect(c.deduped).toBe(false);
    expect(c.jobId).not.toBe(a.jobId);
  });

  test("enqueue while a job is running creates a follow-up queued job", () => {
    // Inbox-process race: J1 is mid-scan, the user uploads another file. The
    // new enqueue must create J2 (not silently dedupe onto the running J1),
    // so that processSource gets a second pass after J1 finishes.
    const a = enqueueJob(
      { kind: "inbox-process", source: "foo", dedupeKey: "inbox-process:foo" },
      db
    );
    const claimed = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(claimed?.id).toBe(a.jobId);
    expect(claimed?.status).toBe("running");

    const b = enqueueJob(
      { kind: "inbox-process", source: "foo", dedupeKey: "inbox-process:foo" },
      db
    );
    expect(b.deduped).toBe(false);
    expect(b.jobId).not.toBe(a.jobId);

    // A third enqueue while J2 is queued and J1 is still running should
    // dedupe onto J2 (only one queued slot per key).
    const c = enqueueJob(
      { kind: "inbox-process", source: "foo", dedupeKey: "inbox-process:foo" },
      db
    );
    expect(c.deduped).toBe(true);
    expect(c.jobId).toBe(b.jobId);
  });

  test("claimNextJob respects priority and FIFO order", () => {
    enqueueJob({ kind: "sync", source: "a", dedupeKey: "sync:a", priority: 0 }, db);
    enqueueJob({ kind: "sync", source: "b", dedupeKey: "sync:b", priority: 5 }, db);
    enqueueJob({ kind: "sync", source: "c", dedupeKey: "sync:c", priority: 0 }, db);

    const first = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(first?.source).toBe("b"); // highest priority
    const second = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(second?.source).toBe("a"); // lowest id among priority=0
    const third = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(third?.source).toBe("c");
    const fourth = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(fourth).toBeNull();
  });

  test("overlap claim filters partition sync work without excluding inbox or null sources", () => {
    const description = enqueueJob({ kind: "sync", source: "vision", priority: 100 }, db);
    const inbox = enqueueJob({ kind: "inbox-process", source: "vision", priority: 20 }, db);
    const sourceLess = enqueueJob({ kind: "sync", priority: 15 }, db);
    const ordinary = enqueueJob({ kind: "sync", source: "ordinary", priority: 10 }, db);
    const future = enqueueJob({ kind: "sync", source: "vision", notBefore: new Date(Date.now() + 60_000) }, db);
    const base = { workerId: "test-worker", leaseMs: 60_000 };

    expect(claimNextJob({ ...base, excludeSyncSource: "vision" }, db)?.id).toBe(inbox.jobId);
    expect(claimNextJob({ ...base, excludeSyncSource: "vision" }, db)?.id).toBe(sourceLess.jobId);
    expect(claimNextJob({ ...base, syncSource: "vision" }, db)?.id).toBe(description.jobId);
    expect(claimNextJob({ ...base, syncSource: "vision" }, db)).toBeNull();
    expect(claimNextJob({ ...base, excludeSyncSource: "vision" }, db)?.id).toBe(ordinary.jobId);
    expect(claimNextJob({ ...base, excludeSyncSource: "vision" }, db)).toBeNull();
    expect(getJob(future.jobId, db)?.status).toBe("queued");
  });

  test("enqueue derives priority from trigger when unset", () => {
    const manual = enqueueJob({ kind: "sync", source: "m", dedupeKey: "sync:m", trigger: "manual" }, db);
    const upload = enqueueJob(
      { kind: "inbox-process", source: "u", dedupeKey: "inbox-process:u", trigger: "upload" },
      db
    );
    const scheduled = enqueueJob({ kind: "sync", source: "s", dedupeKey: "sync:s", trigger: "scheduler" }, db);
    const watched = enqueueJob(
      { kind: "inbox-process", source: "w", dedupeKey: "inbox-process:w", trigger: "inbox-watcher" },
      db
    );

    expect(getJob(manual.jobId, db)?.priority).toBe(10);
    expect(getJob(upload.jobId, db)?.priority).toBe(10);
    expect(getJob(scheduled.jobId, db)?.priority).toBe(0);
    expect(getJob(watched.jobId, db)?.priority).toBe(0);

    // An explicit priority still wins over the per-trigger default.
    const pinned = enqueueJob(
      { kind: "sync", source: "p", dedupeKey: "sync:p", trigger: "manual", priority: 0 },
      db
    );
    expect(getJob(pinned.jobId, db)?.priority).toBe(0);
  });

  test("manual and upload jobs are claimed before an earlier scheduled job", () => {
    // Trigger-derived priority: a scheduled sync enqueued first must still yield
    // to a later dashboard "run now" and an uploaded file.
    enqueueJob({ kind: "sync", source: "scheduled", dedupeKey: "sync:scheduled", trigger: "scheduler" }, db);
    enqueueJob({ kind: "sync", source: "manual", dedupeKey: "sync:manual", trigger: "manual" }, db);
    enqueueJob(
      { kind: "inbox-process", source: "uploaded", dedupeKey: "inbox-process:uploaded", trigger: "upload" },
      db
    );

    // priority 10 drains before priority 0; ties (manual vs upload) break FIFO by id.
    expect(claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db)?.source).toBe("manual");
    expect(claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db)?.source).toBe("uploaded");
    expect(claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db)?.source).toBe("scheduled");
  });

  test("dedupe escalates a queued job's priority but never lowers it", () => {
    // A background sync for a source is queued; a later "run now" for the same
    // source dedupes onto it and must lift it to interactive priority — without
    // this the human request would stay stuck behind other background jobs.
    const scheduled = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x", trigger: "scheduler" }, db);
    expect(getJob(scheduled.jobId, db)?.priority).toBe(0);

    const manual = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x", trigger: "manual" }, db);
    expect(manual.deduped).toBe(true);
    expect(manual.jobId).toBe(scheduled.jobId);
    expect(getJob(scheduled.jobId, db)?.priority).toBe(10);

    // A subsequent background enqueue dedupes too, and MAX must not drag it back down.
    const again = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x", trigger: "scheduler" }, db);
    expect(again.deduped).toBe(true);
    expect(getJob(scheduled.jobId, db)?.priority).toBe(10);
  });

  test("claimNextJob ignores jobs with not_before in the future", () => {
    const future = new Date(Date.now() + 60_000);
    enqueueJob(
      { kind: "sync", source: "later", dedupeKey: "sync:later", notBefore: future },
      db
    );
    const claimed = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(claimed).toBeNull();
  });

  test("claimNextJob increments attempt and sets running state", () => {
    const { jobId } = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x" }, db);
    const claimed = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.workerId).toBe("w1");
    expect(claimed?.workerLeaseUntil).not.toBeNull();
  });

  test("completeJob sets succeeded with result", () => {
    const { jobId } = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x" }, db);
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    completeJob(jobId, { eventsAdded: 7 }, db);
    const job = getJob(jobId, db);
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toEqual({ eventsAdded: 7 });
    expect(job?.finishedAt).not.toBeNull();
  });

  test("failJob without retry marks failed", () => {
    const { jobId } = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x" }, db);
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    failJob(jobId, "boom", { retry: false }, db);
    const job = getJob(jobId, db);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("boom");
  });

  test("failJob with retry under max_attempts requeues", () => {
    const { jobId } = enqueueJob(
      { kind: "sync", source: "x", dedupeKey: "sync:x", maxAttempts: 3 },
      db
    );
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    failJob(jobId, "transient", { retry: true, backoffMs: 0 }, db);
    const job = getJob(jobId, db);
    expect(job?.status).toBe("queued");
    expect(job?.attempt).toBe(1);
    expect(job?.error).toBe("transient");
  });

  test("requeueJob returns a running job to queued without consuming an attempt", () => {
    const { jobId } = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x" }, db);
    const claimed = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(claimed?.attempt).toBe(1);

    // Graceful stop mid-run: the job was preempted, not failed.
    requeueJob(jobId, "Requeued after runner stop", db);

    const job = getJob(jobId, db);
    expect(job?.status).toBe("queued");
    // The claim's attempt increment is undone, so the preemption leaves the
    // retry budget intact — a default maxAttempts=1 job can still run again.
    expect(job?.attempt).toBe(0);
    expect(job?.workerId).toBeNull();
    expect(job?.workerLeaseUntil).toBeNull();
    expect(job?.startedAt).toBeNull();
    expect(job?.error).toBe("Requeued after runner stop");

    // Re-claiming brings it back to attempt 1 — a clean second run.
    const reclaimed = claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(reclaimed?.id).toBe(jobId);
    expect(reclaimed?.attempt).toBe(1);
  });

  test("requeueJob does not resurrect a terminal job", () => {
    // If a job completes in the instant before interruption, the requeue
    // finalizer must not drag it back from `succeeded` to `queued`.
    const { jobId } = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x" }, db);
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    completeJob(jobId, { ok: true }, db);

    requeueJob(jobId, "Requeued after runner stop", db);

    expect(getJob(jobId, db)?.status).toBe("succeeded");
  });

  for (const kind of ["sync", "inbox-process"] as const) {
    for (const recovery of ["stop", "retry", "lease"] as const) {
      test(`${recovery} preserves an interrupted ${kind} job and its queued follow-up`, () => {
        const request = { kind, source: "example", dedupeKey: `${kind}:example` };
        const original = enqueueJob({
          ...request, payload: { pass: "original" }, trigger: "scheduler", maxAttempts: 3,
        }, db);
        claimNextJob({ workerId: "old-worker", leaseMs: -2000 }, db);
        const followup = enqueueJob({
          ...request, payload: { pass: "followup" }, trigger: "manual",
          notBefore: new Date(Date.now() + 60_000),
        }, db);
        const followupBefore = getJob(followup.jobId, db);

        if (recovery === "stop") requeueJob(original.jobId, "Stopped", db);
        // SQLite's due-time comparison has second precision; make the retry
        // unambiguously due without waiting for the next clock tick.
        else if (recovery === "retry") failJob(original.jobId, "Transient", { retry: true, backoffMs: -2000 }, db);
        else expect(reclaimExpiredLeases(null, db)).toBe(1);

        const recovered = getJob(original.jobId, db);
        expect(recovered?.status).toBe("queued");
        expect(recovered?.dedupeKey).toBeNull();
        expect(recovered?.payload).toEqual({ pass: "original" });
        expect(recovered?.trigger).toBe("scheduler");
        expect(recovered?.priority).toBe(0);
        expect(recovered?.attempt).toBe(recovery === "stop" ? 0 : 1);
        expect(recovered?.workerId).toBeNull();
        expect(recovered?.workerLeaseUntil).toBeNull();
        expect(recovered?.startedAt).toBeNull();
        expect(getJob(followup.jobId, db)).toEqual(followupBefore);
        expect(enqueueJob(request, db)).toEqual({ jobId: followup.jobId, deduped: true });

        // The follow-up's delay and priority must not replace the interrupted
        // request's own scheduling or payload.
        const claimed = claimNextJob({ workerId: "new-worker", leaseMs: 60_000 }, db);
        expect(claimed?.id).toBe(original.jobId);
        completeJob(original.jobId, { ok: true }, db);
        expect(getJob(followup.jobId, db)?.status).toBe("queued");
      });
    }
  }

  test("lease recovery preserves multiple stale jobs with the same dedupe key", () => {
    const request = { kind: "sync" as const, source: "example", dedupeKey: "sync:example", maxAttempts: 3 };
    const first = enqueueJob(request, db);
    claimNextJob({ workerId: "old-worker-1", leaseMs: -2000 }, db);
    const second = enqueueJob(request, db);
    claimNextJob({ workerId: "old-worker-2", leaseMs: -2000 }, db);

    expect(reclaimExpiredLeases(null, db)).toBe(2);
    expect(getJob(first.jobId, db)?.status).toBe("queued");
    expect(getJob(second.jobId, db)?.status).toBe("queued");
    const jobs = listJobs({ status: "queued" }, db);
    expect(jobs.filter((job) => job.dedupeKey === request.dedupeKey)).toHaveLength(1);
    expect(jobs.filter((job) => job.dedupeKey === null)).toHaveLength(1);
  });

  test("reclaimExpiredLeases requeues stale running rows", () => {
    const { jobId } = enqueueJob(
      { kind: "sync", source: "x", dedupeKey: "sync:x", maxAttempts: 3 },
      db
    );
    // Negative lease means worker_lease_until is already in the past
    // (avoids relying on SQLite's second-precision clock advancing during the test).
    claimNextJob({ workerId: "w1", leaseMs: -2000 }, db);
    const reclaimed = reclaimExpiredLeases(null, db);
    expect(reclaimed).toBe(1);
    const job = getJob(jobId, db);
    expect(job?.status).toBe("queued");
    expect(job?.workerLeaseUntil).toBeNull();
    expect(job?.dedupeKey).toBe("sync:x");
  });

  test("reclaimExpiredLeases marks failed when attempts exhausted", () => {
    const { jobId } = enqueueJob(
      { kind: "sync", source: "x", dedupeKey: "sync:x", maxAttempts: 1 },
      db
    );
    claimNextJob({ workerId: "w1", leaseMs: -2000 }, db);
    reclaimExpiredLeases(null, db);
    const job = getJob(jobId, db);
    expect(job?.status).toBe("failed");
  });

  test("reclaimExpiredLeases skips the excluded worker's own leases", () => {
    const { jobId } = enqueueJob(
      { kind: "sync", source: "x", dedupeKey: "sync:x", maxAttempts: 3 },
      db
    );
    // Expired lease held by w1 (negative lease => already in the past).
    claimNextJob({ workerId: "w1", leaseMs: -2000 }, db);

    // A live w1 must not reclaim its own in-flight row...
    expect(reclaimExpiredLeases("w1", db)).toBe(0);
    expect(getJob(jobId, db)?.status).toBe("running");

    // ...but any other worker (or unscoped startup cleanup) still reclaims it.
    expect(reclaimExpiredLeases("w2", db)).toBe(1);
    expect(getJob(jobId, db)?.status).toBe("queued");
  });

  test("cancelJob cancels queued, refuses running", () => {
    const a = enqueueJob({ kind: "sync", source: "a", dedupeKey: "sync:a" }, db);
    expect(cancelJob(a.jobId, db)).toBe(true);
    expect(getJob(a.jobId, db)?.status).toBe("cancelled");

    const b = enqueueJob({ kind: "sync", source: "b", dedupeKey: "sync:b" }, db);
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(cancelJob(b.jobId, db)).toBe(false);
    expect(getJob(b.jobId, db)?.status).toBe("running");
  });

  test("failAllRunningJobs marks running rows failed", () => {
    const { jobId } = enqueueJob({ kind: "sync", source: "x", dedupeKey: "sync:x" }, db);
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    const failed = failAllRunningJobs(db);
    expect(failed).toBe(1);
    expect(getJob(jobId, db)?.status).toBe("failed");
  });

  test("listJobs filters and pages", () => {
    const a = enqueueJob({ kind: "sync", source: "a", dedupeKey: "sync:a" }, db);
    const b = enqueueJob(
      { kind: "inbox-process", source: "b", dedupeKey: "inbox-process:b" },
      db
    );
    // Claim the higher-priority / lower-id job first → a goes running, b stays queued.
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);

    const queued = listJobs({ status: "queued" }, db);
    expect(queued.map((j) => j.id)).toEqual([b.jobId]);

    const running = listJobs({ status: "running" }, db);
    expect(running.map((j) => j.id)).toEqual([a.jobId]);

    const allSync = listJobs({ kind: "sync" }, db);
    expect(allSync.length).toBe(1);

    const bySource = listJobs({ source: "b" }, db);
    expect(bySource.length).toBe(1);
    expect(bySource[0].kind).toBe("inbox-process");
  });

  test("countActiveJobs counts queued+running", () => {
    enqueueJob({ kind: "sync", source: "a", dedupeKey: "sync:a" }, db);
    enqueueJob({ kind: "sync", source: "b", dedupeKey: "sync:b" }, db);
    claimNextJob({ workerId: "w1", leaseMs: 60_000 }, db);
    expect(countActiveJobs({}, db)).toBe(2);
    expect(countActiveJobs({ kind: "sync" }, db)).toBe(2);
    expect(countActiveJobs({ source: "a" }, db)).toBe(1);
  });
});
