/**
 * Shared retry helper for HTTP-based sources.
 *
 * Wraps an async operation in bounded exponential backoff built on an Effect
 * `Schedule`. The Effect stays *internal* to this module — callers pass a plain
 * thunk (and optionally a transient-error predicate) and receive a plain
 * `Promise`. This keeps the retry policy declarative and shared while leaving
 * consumers (sync sources, parsers, API clients) free of any Effect import.
 */

import { Cause, Duration, Effect, Exit, Schedule } from "effect";

/** Bounded exponential-backoff retry policy for transient HTTP failures. */
export interface HttpRetryConfig {
  /** Retries after the initial attempt (0 disables retrying). */
  maxRetries: number;
  /** Base backoff delay; doubles per retry, then jittered 0.8–1.2x. */
  baseDelayMs: number;
}

const DEFAULT_HTTP_RETRY: HttpRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
};

/**
 * Default transient-error policy: an HTTP 5xx (any error carrying a numeric
 * `status >= 500`) or a network error (`fetch` rejects with a `TypeError`). 4xx
 * responses — including 429 — are permanent. Sources only need to throw an error
 * carrying a numeric `status`; pass a custom `isTransient` to deviate.
 */
export function isTransientHttpError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    return typeof error.status === "number" && error.status >= 500;
  }
  return error instanceof TypeError;
}

export interface HttpRetryOptions extends Partial<HttpRetryConfig> {
  /**
   * Should this error be retried? Defaults to {@link isTransientHttpError} (5xx
   * or network error). Errors for which this returns `false` are re-thrown
   * immediately (e.g. 4xx auth/not-found, or a 429 the caller handles itself).
   */
  isTransient?: (error: unknown) => boolean;
}

/**
 * Run `operation`, retrying transient failures with bounded exponential backoff
 * (jittered). On exhaustion — or the first non-transient error — the *original*
 * error is re-thrown unchanged, so caller-side `instanceof`/status handling
 * behaves exactly as it would without the wrapper.
 */
export async function httpRetry<T>(
  operation: () => Promise<T>,
  options: HttpRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_HTTP_RETRY.maxRetries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_HTTP_RETRY.baseDelayMs;
  const isTransient = options.isTransient ?? isTransientHttpError;

  const schedule = Schedule.recurs(maxRetries).pipe(
    Schedule.intersect(Schedule.exponential(Duration.millis(baseDelayMs), 2)),
    Schedule.jittered,
  );

  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: operation,
      catch: (error) => error,
    }).pipe(Effect.retry({ while: isTransient, schedule })),
  );

  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
