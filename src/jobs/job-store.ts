/**
 * Job store service (Effect)
 *
 * A thin Effect wrapper over the synchronous `store.ts` helpers. The store
 * itself stays plain `bun:sqlite` — this layer only lifts the four operations
 * the runner needs into the Effect world so they can participate in the typed
 * error channel and be swapped for an in-memory fake in tests.
 *
 * Why a service (rather than calling `store.ts` inline): it gives the runner a
 * single injectable seam. `JobStoreLive` is the real DB; tests provide a fake
 * `JobStore` layer and never touch SQLite.
 */

import { Context, Data, Effect, Layer } from "effect";
import {
  claimNextJob,
  completeJob,
  failJob,
  reclaimExpiredLeases,
  requeueJob,
  type ClaimOptions,
} from "./store";
import type { Job } from "./types";

/** `claimNextJob` threw (SQLite/transaction error). */
export class ClaimError extends Data.TaggedError("ClaimError")<{
  readonly cause: unknown;
}> {}

/** A write-back (`complete`/`fail`/`reclaimExpired`) threw. */
export class StoreError extends Data.TaggedError("StoreError")<{
  readonly cause: unknown;
}> {}

export class JobStore extends Context.Tag("jobs/JobStore")<
  JobStore,
  {
    readonly claimNext: (opts: ClaimOptions) => Effect.Effect<Job | null, ClaimError>;
    readonly complete: (
      id: number,
      result: Record<string, unknown> | null
    ) => Effect.Effect<void, StoreError>;
    readonly fail: (id: number, error: string) => Effect.Effect<void, StoreError>;
    readonly requeue: (id: number, reason: string) => Effect.Effect<void, StoreError>;
    readonly reclaimExpired: (excludeWorkerId: string) => Effect.Effect<number, StoreError>;
  }
>() {}

/** Backs `JobStore` with the real app-state database via `store.ts`. */
export const JobStoreLive = Layer.succeed(JobStore, {
  claimNext: (opts) =>
    Effect.try({ try: () => claimNextJob(opts), catch: (cause) => new ClaimError({ cause }) }),
  complete: (id, result) =>
    Effect.try({ try: () => completeJob(id, result), catch: (cause) => new StoreError({ cause }) }),
  fail: (id, error) =>
    Effect.try({ try: () => failJob(id, error), catch: (cause) => new StoreError({ cause }) }),
  requeue: (id, reason) =>
    Effect.try({ try: () => requeueJob(id, reason), catch: (cause) => new StoreError({ cause }) }),
  reclaimExpired: (excludeWorkerId) =>
    Effect.try({
      try: () => reclaimExpiredLeases(excludeWorkerId),
      catch: (cause) => new StoreError({ cause }),
    }),
});
