/**
 * Existing-cache upload: push blobs that are present locally but not yet in the
 * remote backend. Closes the gap left by write-through, which only uploaded
 * media added *after* R2 was enabled.
 *
 * Read-only with respect to the timeline DB and the local cache — it only reads
 * local bytes and writes to the remote. Idempotent and resumable: anything
 * already in R2 is skipped (membership is checked against R2 directly, so a
 * re-run after an interruption uploads only what's still missing).
 */

import type { Database } from "bun:sqlite";
import { Effect, Exit } from "effect";
import type { RemoteBlobStore } from "./storage";
import { collectMediaBlobs } from "./inventory";
import type { MediaTable } from "./registry";
import {
  putRemoteBlobWithRetry,
  resolveMediaUploadRetryOptions,
  type MediaUploadRetryOptions,
} from "./upload-retry";

/** The slice of a local store the upload reads through. */
export interface LocalReader {
  hasHash(hash: string, ext: string): Promise<boolean>;
  readByHash(hash: string, ext: string): Promise<Buffer | null>;
}

export interface UploadOptions extends MediaUploadRetryOptions {
  /** When true (default), report what would be uploaded without writing to R2. */
  dryRun?: boolean;
  /** Cap the number of blobs uploaded this run (for staged rollouts/testing). */
  limit?: number;
  /** Parallel uploads (default 4). */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  tables?: readonly MediaTable[];
}

export interface UploadResult {
  /** Blobs already present in R2 (skipped). */
  alreadyInR2: number;
  /** Local-only blobs eligible for upload. */
  toUpload: number;
  toUploadBytes: number;
  /** Blobs uploaded this run (0 on a dry run). */
  uploaded: number;
  uploadedBytes: number;
  failed: number;
  dryRun: boolean;
}

export async function uploadLocalMedia(
  db: Database,
  local: LocalReader,
  remote: RemoteBlobStore,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const dryRun = options.dryRun ?? true;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new Error(`limit must be a non-negative integer, got ${options.limit}`);
  }
  const uploadRetry = resolveMediaUploadRetryOptions(options);

  const { blobs } = collectMediaBlobs(db, options.tables);
  const present = await remote.presentHashes(blobs.keys());

  // Candidates: locally present (under some extension) and not already in R2.
  const candidates: { hash: string; ext: string; size: number }[] = [];
  for (const [hash, meta] of blobs) {
    if (present.has(hash)) continue;
    for (const ext of meta.exts) {
      if (await local.hasHash(hash, ext)) {
        candidates.push({ hash, ext, size: meta.size });
        break;
      }
    }
  }

  const result: UploadResult = {
    alreadyInR2: present.size,
    toUpload: candidates.length,
    toUploadBytes: candidates.reduce((sum, c) => sum + c.size, 0),
    uploaded: 0,
    uploadedBytes: 0,
    failed: 0,
    dryRun,
  };

  if (dryRun) return result;

  const work = options.limit !== undefined ? candidates.slice(0, options.limit) : candidates;

  // Upload through a sliding-window concurrency pool: always up to `concurrency`
  // in flight (no head-of-line blocking from fixed batches). Each item runs to an
  // Exit so a single failure never aborts the run; successes and failures are
  // tallied afterward. Effect stays internal here — the export is Promise-shaped.
  let done = 0;
  const exits = await Effect.runPromise(
    Effect.forEach(
      work,
      (c) =>
        Effect.gen(function* () {
          const bytes = yield* Effect.tryPromise(() => local.readByHash(c.hash, c.ext));
          if (!bytes) {
            return yield* Effect.fail(new Error(`local blob missing at upload time: ${c.hash}`));
          }
          // Retry only the network PUT, and only for throttle/transient errors.
          yield* Effect.tryPromise({
            try: () =>
              putRemoteBlobWithRetry(remote, c.hash, bytes, uploadRetry),
            catch: (e) => e,
          });
          return c.size;
        }).pipe(
          Effect.exit,
          Effect.tap(() =>
            Effect.sync(() => {
              done++;
              options.onProgress?.(done, work.length);
            }),
          ),
        ),
      { concurrency },
    ),
  );

  for (const exit of exits) {
    if (Exit.isSuccess(exit)) {
      result.uploaded++;
      result.uploadedBytes += exit.value;
    } else {
      result.failed++;
    }
  }

  return result;
}
