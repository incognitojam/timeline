/**
 * Job runner tests
 *
 * Exercises the dispatch loop end-to-end against the global app-state DB
 * (set up by test/setup.ts), with synthetic handlers in place of the real
 * scheduler/watcher.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { getAppStateDb } from "../db/app-state";
import { enqueueJob, getJob } from "./store";
import { JobRunner } from "./runner";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

describe("jobs/runner", () => {
  beforeEach(() => {
    getAppStateDb().exec("DELETE FROM jobs");
  });

  test("runs a queued job and marks it succeeded with the handler's result", async () => {
    const { jobId } = enqueueJob({
      kind: "sync",
      source: "runner-test-success",
      dedupeKey: "sync:runner-test-success",
    });

    const runner = new JobRunner({
      pollIdleMs: 50,
      pollActiveMs: 10,
      handlers: {
        sync: async () => ({ events: 7 }),
      },
    });

    runner.start();
    try {
      await waitFor(() => getJob(jobId)?.status === "succeeded", 2000);
    } finally {
      await runner.stop(1000);
    }

    const job = getJob(jobId);
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toEqual({ events: 7 });
  });

  test("handler exception marks the job failed", async () => {
    const { jobId } = enqueueJob({
      kind: "sync",
      source: "runner-test-failure",
      dedupeKey: "sync:runner-test-failure",
    });

    const runner = new JobRunner({
      pollIdleMs: 50,
      pollActiveMs: 10,
      handlers: {
        sync: async () => {
          throw new Error("boom");
        },
      },
    });

    runner.start();
    try {
      await waitFor(() => getJob(jobId)?.status === "failed", 2000);
    } finally {
      await runner.stop(1000);
    }

    expect(getJob(jobId)?.error).toBe("boom");
  });

  test("runner.stop() aborts the in-flight handler via its AbortSignal and requeues it", async () => {
    const { jobId } = enqueueJob({
      kind: "sync",
      source: "runner-test-abort",
      dedupeKey: "sync:runner-test-abort",
    });

    let signalReceived: AbortSignal | null = null;
    let abortObserved = false;

    const runner = new JobRunner({
      pollIdleMs: 50,
      pollActiveMs: 10,
      handlers: {
        sync: async (_job, signal) => {
          signalReceived = signal;
          // Wait for either an abort signal or 5 seconds (whichever comes first).
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              abortObserved = true;
              clearTimeout(timer);
              resolve();
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              resolve();
            }, 5000);
            signal.addEventListener("abort", onAbort, { once: true });
          });
          if (signal.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
        },
      },
    });

    runner.start();
    await waitFor(() => signalReceived !== null, 2000);

    const stopStart = Date.now();
    await runner.stop(2000);
    const stopElapsed = Date.now() - stopStart;

    expect(abortObserved).toBe(true);
    // Stop should be quick (well under the handler's 5s would-otherwise wait).
    expect(stopElapsed).toBeLessThan(2000);
    // A graceful stop preempts the in-flight job: it returns to `queued` to
    // resume on the next boot, rather than being recorded as `failed`.
    expect(getJob(jobId)?.status).toBe("queued");
  });

  test("stop and restart runs both the interrupted job and its queued follow-up", async () => {
    const request = {
      kind: "sync" as const,
      source: "runner-test-followup",
      dedupeKey: "sync:runner-test-followup",
    };
    const original = enqueueJob({ ...request, payload: { pass: "original" } });
    let started = false;
    const runner = new JobRunner({
      pollIdleMs: 10,
      pollActiveMs: 10,
      handlers: {
        sync: async (_job, signal) => {
          started = true;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          signal.throwIfAborted();
        },
      },
    });

    let followupId = 0;
    runner.start();
    try {
      await waitFor(() => started);
      followupId = enqueueJob({ ...request, payload: { pass: "followup" } }).jobId;
    } finally {
      await runner.stop(1000);
    }
    expect(getJob(original.jobId)?.status).toBe("queued");
    expect(getJob(followupId)?.status).toBe("queued");

    const seen: unknown[] = [];
    const restarted = new JobRunner({
      pollIdleMs: 10,
      pollActiveMs: 10,
      handlers: {
        sync: async (job) => { seen.push(job.payload); },
      },
    });
    restarted.start();
    try {
      await waitFor(() => getJob(followupId)?.status === "succeeded");
    } finally {
      await restarted.stop(1000);
    }
    expect(getJob(original.jobId)?.status).toBe("succeeded");
    expect(getJob(original.jobId)?.attempt).toBe(1);
    expect(seen).toEqual([{ pass: "original" }, { pass: "followup" }]);
  });
});
