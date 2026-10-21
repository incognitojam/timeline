/**
 * Job runner — Effect internals
 *
 * Drives the inner Effect program (the work + reclaim loops) directly with an
 * in-memory `JobStore` and a `TestClock`, so cadence and interruption can be
 * asserted deterministically with no real waiting. The behavioral end-to-end
 * coverage against a real DB lives in `runner.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, TestClock, TestContext } from "effect";
import { JobStore } from "./job-store";
import { Handlers, makeReclaimLoop, makeWorkLoop, type RunnerConfig } from "./runner";
import type { Job } from "./types";

const config = (overrides: Partial<RunnerConfig> = {}): RunnerConfig => ({
  workerId: "test-worker",
  pollIdleMs: 2000,
  pollActiveMs: 500,
  leaseMs: 60_000,
  reclaimEveryMs: 30_000,
  verbose: false,
  ...overrides,
});

const sampleJob: Job = {
  id: 1,
  kind: "sync",
  source: "test-source",
  payload: {},
  dedupeKey: null,
  status: "running",
  priority: 0,
  attempt: 1,
  maxAttempts: 1,
  enqueuedAt: "2026-01-01 00:00:00",
  notBefore: "2026-01-01 00:00:00",
  startedAt: "2026-01-01 00:00:00",
  finishedAt: null,
  workerId: "test-worker",
  workerLeaseUntil: null,
  result: null,
  error: null,
  trigger: "manual",
};

describe("jobs/runner Effect internals", () => {
  test("reclaim fires immediately then once per reclaimEveryMs, scoped to this worker", async () => {
    let reclaimCount = 0;
    const excludedWorkers: string[] = [];
    let resolveFirst!: () => void;
    const firstReclaim = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const store: JobStore["Type"] = {
      claimNext: () => Effect.succeed(null),
      complete: () => Effect.void,
      fail: () => Effect.void,
      requeue: () => Effect.void,
      reclaimExpired: (excludeWorkerId) =>
        Effect.sync(() => {
          reclaimCount += 1;
          excludedWorkers.push(excludeWorkerId);
          if (reclaimCount === 1) resolveFirst();
          return 0;
        }),
    };

    const snapshots: number[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          makeReclaimLoop(config({ workerId: "worker-A", reclaimEveryMs: 30_000 })).pipe(
            Effect.provideService(JobStore, store)
          )
        );
        // Let the immediate (t=0) reclaim run before advancing the clock.
        yield* Effect.promise(() => firstReclaim);
        snapshots.push(reclaimCount);
        yield* TestClock.adjust(Duration.millis(30_000));
        snapshots.push(reclaimCount);
        yield* TestClock.adjust(Duration.millis(30_000));
        snapshots.push(reclaimCount);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestContext.TestContext))
    );

    expect(snapshots).toEqual([1, 2, 3]);
    // The runner must exclude its own jobs from reclaim (see store.test.ts).
    expect(excludedWorkers).toContain("worker-A");
  });

  test("poll loop waits the active delay after a claim and the idle delay when empty", async () => {
    let claimCount = 0;
    let resolveFirst!: () => void;
    const firstClaim = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    // First poll claims a job; the rest come back empty. No handler is
    // registered on purpose: the no-handler path is fully synchronous, so the
    // loop's cadence is driven solely by the TestClock (no stray microtasks).
    const store: JobStore["Type"] = {
      claimNext: () =>
        Effect.sync(() => {
          claimCount += 1;
          if (claimCount === 1) resolveFirst();
          return claimCount === 1 ? sampleJob : null;
        }),
      complete: () => Effect.void,
      fail: () => Effect.void,
      requeue: () => Effect.void,
      reclaimExpired: () => Effect.succeed(0),
    };

    const snapshots: number[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          makeWorkLoop(config({ pollActiveMs: 500, pollIdleMs: 2000 })).pipe(
            Effect.provideService(JobStore, store),
            Effect.provideService(Handlers, {})
          )
        );
        yield* Effect.promise(() => firstClaim);
        snapshots.push(claimCount); // poll #1 claimed -> sleeping the active delay
        yield* TestClock.adjust(Duration.millis(500));
        snapshots.push(claimCount); // active delay elapsed -> poll #2 (empty)
        yield* TestClock.adjust(Duration.millis(500));
        snapshots.push(claimCount); // idle delay (2000) not yet elapsed -> no poll
        yield* TestClock.adjust(Duration.millis(1500));
        snapshots.push(claimCount); // idle delay elapsed -> poll #3
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestContext.TestContext))
    );

    expect(snapshots).toEqual([1, 2, 2, 3]);
  });

  test("interrupting mid-handler fires the AbortSignal and requeues the job", async () => {
    let abortObserved = false;
    let claimedOnce = false;
    const failCalls: Array<{ id: number; error: string }> = [];
    const requeueCalls: Array<{ id: number; reason: string }> = [];
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const store: JobStore["Type"] = {
      claimNext: () =>
        Effect.sync(() => {
          if (claimedOnce) return null;
          claimedOnce = true;
          return sampleJob;
        }),
      complete: () => Effect.void,
      fail: (id, error) =>
        Effect.sync(() => {
          failCalls.push({ id, error });
        }),
      requeue: (id, reason) =>
        Effect.sync(() => {
          requeueCalls.push({ id, reason });
        }),
      reclaimExpired: () => Effect.succeed(0),
    };

    const handlers: Handlers["Type"] = {
      sync: (_job, signal) =>
        new Promise((_resolve, reject) => {
          resolveStarted();
          // Block until aborted — the runner stop is what ends this handler.
          signal.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              reject(new Error("aborted"));
            },
            { once: true }
          );
        }),
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          makeWorkLoop(config()).pipe(
            Effect.provideService(JobStore, store),
            Effect.provideService(Handlers, handlers)
          )
        );
        yield* Effect.promise(() => started);
        yield* Fiber.interrupt(fiber);
      })
    );

    expect(abortObserved).toBe(true);
    // Interruption flows through the requeue finalizer, not the failure path:
    // a graceful stop preempts the job, it does not fail it.
    expect(requeueCalls).toEqual([{ id: sampleJob.id, reason: "Requeued after runner stop" }]);
    expect(failCalls).toEqual([]);
  });
});
