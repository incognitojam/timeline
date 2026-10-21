/**
 * Job runner
 *
 * Runs inside the scheduler worker thread. Polls the jobs table, claims work,
 * dispatches to a per-kind handler, and writes the outcome back to the row.
 *
 * The runner is the only place jobs transition from `queued` to `running` to
 * a terminal state. Worker lifecycle still flows over postMessage; only
 * work-trigger IPC has been replaced.
 *
 * Internally the loop is an Effect program (see `makeRunnerProgram`) run on a
 * `ManagedRuntime`. The `JobRunner` class below is a thin imperative shell that
 * preserves the original `start()` / `stop()` / `isRunning()` surface so its
 * callers — the worker and the existing tests — are unaware Effect is involved.
 * The two payoffs over the previous hand-rolled version:
 *   - `stop()` is a `Fiber.interrupt`, which fires the in-flight handler's
 *     `AbortSignal` for free (Effect aborts the `tryPromise` signal on interrupt)
 *     and runs finalizers — no `stopRequested` flag or `Promise.race` timeout.
 *   - reclaim runs on its own fiber on a fixed `Schedule`, decoupled from the
 *     claim loop's cadence.
 */

import { randomUUID } from "crypto";
import { Context, Data, Duration, Effect, Fiber, Layer, ManagedRuntime, Schedule } from "effect";
import { JobStore, JobStoreLive } from "./job-store";
import { LocalWorkGate } from "./local-work";
import type { ClaimOptions } from "./store";
import type { Job, JobKind } from "./types";

export type JobHandler = (
  job: Job,
  signal: AbortSignal,
  localWork?: LocalWorkGate,
) => Promise<Record<string, unknown> | null | void>;

/** How long a claimed job may run before another worker can reclaim it. */
export const DEFAULT_JOB_LEASE_MS = 10 * 60_000;

export interface RunnerOptions {
  workerId?: string;
  pollIdleMs?: number;
  pollActiveMs?: number;
  leaseMs?: number;
  reclaimEveryMs?: number;
  verbose?: boolean;
  handlers: Partial<Record<JobKind, JobHandler>>;
  /** This source coordinates its own local phases using the handler's guard. */
  overlapSyncSource?: string;
}

/** Resolved runner settings (defaults applied), shared by the loop and reclaim fibers. */
export interface RunnerConfig {
  workerId: string;
  pollIdleMs: number;
  pollActiveMs: number;
  leaseMs: number;
  reclaimEveryMs: number;
  verbose: boolean;
  overlapSyncSource?: string;
}

/** A job handler threw. Carries the job id for logging and the original error. */
class HandlerError extends Data.TaggedError("HandlerError")<{
  readonly jobId: number;
  readonly cause: unknown;
}> {}

/** The per-kind handler map, injected so the program is testable without the real worker. */
export class Handlers extends Context.Tag("jobs/Handlers")<
  Handlers,
  Partial<Record<JobKind, JobHandler>>
>() {}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Run a single claimed job: dispatch to its handler, then record the outcome.
 *
 * - handler success → `complete`
 * - handler/store failure → `fail` with the error message (matches prior behavior)
 * - interrupted mid-handler (graceful stop, e.g. a deploy) → `requeue`. The job
 *   was preempted, not failed, so it returns to `queued` and resumes on the next
 *   boot — it survives the startup `failAllRunningJobs`, which only touches
 *   `running` rows. A hard crash, where this finalizer never runs, leaves the
 *   row `running` and is failed by that same startup sweep, so crash and
 *   graceful-stop stay distinct outcomes.
 */
const dispatch = (job: Job, config: RunnerConfig, localWork: LocalWorkGate, inferenceWork: LocalWorkGate) =>
  Effect.gen(function* () {
    const store = yield* JobStore;
    const handlers = yield* Handlers;
    const handler = handlers[job.kind];
    if (!handler) {
      yield* store.fail(job.id, `No handler registered for job kind: ${job.kind}`);
      return;
    }

    if (config.verbose) {
      yield* Effect.sync(() =>
        console.log(`[JobRunner] Running job #${job.id} (${job.kind} ${job.source ?? "-"})`)
      );
    }

    const result = yield* Effect.tryPromise({
      try: (signal) => {
        const overlaps = job.kind === "sync" && job.source === config.overlapSyncSource;
        const gate = overlaps ? inferenceWork : localWork;
        // Serial handlers already own local work. Only the overlapping source
        // receives a guard to acquire for its individual phases.
        return gate.run(() => handler(job, signal, overlaps ? localWork : undefined), signal);
      },
      catch: (cause) => new HandlerError({ jobId: job.id, cause }),
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.flatMap(JobStore, (s) => s.requeue(job.id, "Requeued after runner stop")).pipe(
          Effect.ignore
        )
      )
    );

    yield* store.complete(job.id, result ?? null);
    if (config.verbose) {
      yield* Effect.sync(() => console.log(`[JobRunner] Completed job #${job.id}`));
    }
  }).pipe(
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        const store = yield* JobStore;
        yield* Effect.sync(() =>
          console.error(`[JobRunner] Job #${job.id} (${job.kind}) failed:`, err.cause)
        );
        yield* store.fail(job.id, messageOf(err.cause)).pipe(
          Effect.catchAll((storeErr) =>
            Effect.sync(() =>
              console.error(`[JobRunner] Failed to record failure for job #${job.id}:`, storeErr.cause)
            )
          )
        );
      })
    )
  );

/** One poll: claim a job (if any) and run it. Returns whether a job was claimed. */
const claimAndRun = (
  config: RunnerConfig,
  localWork: LocalWorkGate,
  inferenceWork: LocalWorkGate,
  filter: Pick<ClaimOptions, "syncSource" | "excludeSyncSource">,
) =>
  Effect.gen(function* () {
    const store = yield* JobStore;
    const job = yield* store.claimNext({ workerId: config.workerId, leaseMs: config.leaseMs, ...filter });
    if (!job) return false;
    yield* dispatch(job, config, localWork, inferenceWork);
    return true;
  }).pipe(
    // `dispatch` already records its own failures, so only a claim error reaches
    // here. Log and keep polling rather than crash the loop.
    Effect.catchAll((err) =>
      Effect.sync(() => console.error("[JobRunner] claimNextJob failed:", err.cause)).pipe(
        Effect.as(false)
      )
    )
  );

/** Poll forever, sleeping longer when idle than when actively draining the queue. */
export const makeWorkLoop = (
  config: RunnerConfig,
  localWork = new LocalWorkGate(),
  inferenceWork = new LocalWorkGate(),
  filter: Pick<ClaimOptions, "syncSource" | "excludeSyncSource"> = {},
) =>
  claimAndRun(config, localWork, inferenceWork, filter).pipe(
    Effect.flatMap((claimed) =>
      Effect.sleep(Duration.millis(claimed ? config.pollActiveMs : config.pollIdleMs))
    ),
    Effect.forever
  );

/** Reclaim expired leases on a fixed cadence, independent of the claim loop. */
export const makeReclaimLoop = (config: RunnerConfig) =>
  // Exclude our own workerId: a job this runner is actively holding must not be
  // reclaimed by our own reclaim fiber just because its handler outran the lease.
  Effect.flatMap(JobStore, (store) => store.reclaimExpired(config.workerId)).pipe(
    Effect.tap((reclaimed) =>
      reclaimed > 0 && config.verbose
        ? Effect.sync(() => console.log(`[JobRunner] Reclaimed ${reclaimed} stale lease(s)`))
        : Effect.void
    ),
    Effect.catchAll((err) =>
      Effect.sync(() => console.error("[JobRunner] reclaimExpiredLeases failed:", err.cause))
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(config.reclaimEveryMs)))
  );

/**
 * Ordinary work stays serial. An opted-in sync source gets one separate claim
 * loop and must guard its local phases; each loop awaits its whole dispatch.
 */
const makeRunnerProgram = (
  config: RunnerConfig,
  localWork: LocalWorkGate,
  inferenceWork: LocalWorkGate,
): Effect.Effect<void, never, JobStore | Handlers> =>
  Effect.gen(function* () {
    yield* Effect.fork(makeReclaimLoop(config));
    if (config.overlapSyncSource !== undefined) {
      yield* Effect.fork(makeWorkLoop(config, localWork, inferenceWork, { syncSource: config.overlapSyncSource }));
    }
    return yield* makeWorkLoop(config, localWork, inferenceWork, { excludeSyncSource: config.overlapSyncSource });
  });

type RunnerRuntime = ManagedRuntime.ManagedRuntime<JobStore | Handlers, never>;

export class JobRunner {
  private readonly config: RunnerConfig;
  private readonly handlers: Partial<Record<JobKind, JobHandler>>;
  private readonly localWork = new LocalWorkGate();
  private readonly inferenceWork = new LocalWorkGate();

  private running = false;
  private runtime: RunnerRuntime | null = null;
  private fiber: Fiber.RuntimeFiber<void, never> | null = null;

  constructor(options: RunnerOptions) {
    this.config = {
      workerId: options.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`,
      pollIdleMs: options.pollIdleMs ?? 2000,
      pollActiveMs: options.pollActiveMs ?? 500,
      leaseMs: options.leaseMs ?? DEFAULT_JOB_LEASE_MS,
      reclaimEveryMs: options.reclaimEveryMs ?? 30_000,
      verbose: options.verbose ?? false,
      overlapSyncSource: options.overlapSyncSource,
    };
    this.handlers = options.handlers;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.runtime = ManagedRuntime.make(
      Layer.merge(JobStoreLive, Layer.succeed(Handlers, this.handlers))
    );
    this.fiber = this.runtime.runFork(makeRunnerProgram(this.config, this.localWork, this.inferenceWork));
  }

  async stop(timeoutMs = 30_000): Promise<void> {
    if (!this.running) return;
    const runtime = this.runtime;
    const fiber = this.fiber;

    if (runtime && fiber) {
      // Interrupt fires the in-flight handler's AbortSignal and runs finalizers.
      // The timeout bounds a non-cooperative handler; the orphaned promise is
      // detached just as before. dispose() tears down the runtime afterwards.
      await runtime.runPromise(
        Fiber.interrupt(fiber).pipe(Effect.timeout(Duration.millis(timeoutMs)), Effect.ignore)
      );
      await runtime.dispose();
    }

    this.running = false;
    this.runtime = null;
    this.fiber = null;
  }

  isRunning(): boolean {
    return this.running;
  }
}
