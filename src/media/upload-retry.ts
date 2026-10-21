/**
 * Shared retry policy for media blob uploads.
 *
 * The transient operation is the remote PUT (R2/S3 today). Local writes,
 * hash verification, DB updates, and permanent backend errors should fail
 * immediately so callers can surface the real problem.
 */

import { Cause, Duration, Effect, Exit, Schedule } from "effect";
import type { RemoteBlobStore } from "./storage";

/**
 * R2/S3 error codes that should be retried with backoff: the rate-limit/throttle
 * signals and transient server errors. Permanent errors (AccessDenied,
 * NoSuchBucket, ... ) are not retried. Bun's S3 errors expose `.code` but no
 * numeric status, so we match on the code.
 */
const TRANSIENT_S3_CODES = new Set([
  "TooManyRequests", // 429 - R2 rate limit
  "SlowDown", // 503 - S3 throttle
  "ServiceUnavailable", // 503
  "InternalError", // 500
  "RequestTimeout",
]);

export interface MediaUploadRetryOptions {
  /** Base backoff for retrying throttled/transient uploads (default 1000ms; doubles, jittered). */
  retryBaseMs?: number;
  /** Max retries per blob on transient errors (default 5). */
  retryMax?: number;
}

export function resolveMediaUploadRetryOptions(
  options: MediaUploadRetryOptions = {},
): Required<MediaUploadRetryOptions> {
  const retryMax = options.retryMax ?? 5;
  const retryBaseMs = options.retryBaseMs ?? 1000;
  if (!Number.isInteger(retryMax) || retryMax < 0) {
    throw new Error(`retryMax must be a non-negative integer, got ${retryMax}`);
  }
  if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0) {
    throw new Error(`retryBaseMs must be a non-negative number, got ${retryBaseMs}`);
  }
  return { retryBaseMs, retryMax };
}

export function isTransientMediaUploadError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // network-level (fetch) failure
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_S3_CODES.has(code);
}

export async function retryMediaUpload<T>(
  operation: () => Promise<T>,
  options: MediaUploadRetryOptions = {},
): Promise<T> {
  const { retryBaseMs, retryMax } = resolveMediaUploadRetryOptions(options);

  const schedule = Schedule.recurs(retryMax).pipe(
    Schedule.intersect(Schedule.exponential(Duration.millis(retryBaseMs), 2)),
    Schedule.jittered,
  );

  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: operation,
      catch: (error) => error,
    }).pipe(Effect.retry({ while: isTransientMediaUploadError, schedule })),
  );

  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

export async function putRemoteBlobWithRetry(
  remote: RemoteBlobStore,
  contentHash: string,
  content: Uint8Array,
  options: MediaUploadRetryOptions = {},
): Promise<void> {
  await retryMediaUpload(() => remote.put(contentHash, content), options);
}
