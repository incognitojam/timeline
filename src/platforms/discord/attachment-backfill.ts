/**
 * Discord attachment backfill — recover blobs whose local file was lost (e.g. a
 * host failure) but whose Discord message still exists.
 *
 * The stored `original_uri` are time-signed and long expired, so we re-sign them
 * in batches via Discord's `attachments/refresh-urls` endpoint (no per-message
 * refetch needed — every attachment row carries its URL), download the bytes,
 * and write them through the media store (which uploads to R2). The attachment
 * row is then flipped back to `status='stored'`.
 *
 * Circuit breaker: a healthy recovery is almost all success, so a *cluster* of
 * failures means something systemic (token revoked, lost guild access, Discord
 * outage) rather than thousands of individually-deleted messages. We bail in
 * that case instead of tombstoning — see {@link backfillDiscordAttachments}.
 *
 * Effect is used internally for the bounded download pool + transient retry; the
 * exported entry points keep Promise signatures (mirrors src/media/upload.ts).
 */

import type { Database } from "bun:sqlite";
import { extname } from "path";
import { Cause, Duration, Effect, Exit } from "effect";
import { insertPendingAttachment } from "../../media/attachments";
import {
  getMimeType,
  type RemoteBlobStore,
  type StoreFileResult,
} from "../../media/storage";

/** An attachment whose blob needs re-downloading, with what we need to restore it. */
export interface BackfillCandidate {
  /** `attachments.id` — the row to flip to stored/unrecoverable. */
  attachmentId: number;
  /** Discord attachment snowflake (`attachments.source_id`) — part of the storage path. */
  discordId: string;
  /** Discord channel id (from the event's raw_data) — part of the storage path. */
  channelId: string;
  /** The expired `original_uri` we hand to refresh-urls. */
  url: string;
  filename: string;
  /** Recorded size from the attachment row (0 if unknown) — for reporting/progress only. */
  fileSize: number;
}

/** A non-2xx HTTP response, carrying the status so callers can classify it. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message?: string,
    /** Server-requested wait before retrying (from a 429's Retry-After), in ms. */
    readonly retryAfterMs?: number,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
  }
}

/** Retryable: rate limits, transient server/network errors. */
function isTransient(error: unknown): boolean {
  if (error instanceof TypeError) return true; // network-level fetch failure
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  return false;
}

/** Permanently gone: the message/attachment is deleted or inaccessible. */
function isGone(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 403 || error.status === 404 || error.status === 410);
}

/** Auth failure — the token itself is bad, so the whole run must stop. */
function isAuth(error: unknown): boolean {
  return error instanceof HttpError && error.status === 401;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * Retry a transient-failing async op (network / 5xx / 429). A 429 carrying a
 * Retry-After ({@link HttpError.retryAfterMs}) waits at least that long — jittered
 * upward only, so we never retry before the server's window — rather than the
 * generic exponential backoff used for other transient errors. Permanent errors
 * and the final attempt re-raise the original cause unchanged.
 */
function withHttpRetry<A>(run: () => Promise<A>, baseMs: number, maxRetries: number): Effect.Effect<A, unknown> {
  return Effect.gen(function* () {
    let attempt = 0;
    while (true) {
      attempt++;
      const exit = yield* Effect.exit(Effect.tryPromise({ try: run, catch: (e) => e }));
      if (Exit.isSuccess(exit)) return exit.value;
      const error = Cause.squash(exit.cause);
      if (!isTransient(error) || attempt > maxRetries) return yield* Effect.failCause(exit.cause);
      const serverMs = error instanceof HttpError ? error.retryAfterMs : undefined;
      const delayMs =
        serverMs !== undefined
          ? serverMs * (1 + Math.random() * 0.2)
          : Math.min(baseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS) * (0.8 + Math.random() * 0.4);
      yield* Effect.sleep(Duration.millis(delayMs));
    }
  });
}

/** The slice of a local store the recovery-set scan reads through. */
export interface LocalPresence {
  hasHash(hash: string, ext: string): Promise<boolean>;
}

export interface UntrackedDiscordSnapshotAttachment {
  eventId: number;
  discordId: string;
  url: string;
  filename: string;
  fileSize: number;
  contentType: string | null;
  width: number | null;
  height: number | null;
}

interface UntrackedSnapshotRow {
  event_id: number;
  source_id: string;
  original_uri: string;
  filename: string;
  file_size: number;
  content_type: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Forwarded Discord files captured in raw_data but never registered in the
 * attachments table. Older sync code only inspected the forwarding wrapper.
 */
export function findUntrackedDiscordSnapshotAttachments(
  db: Database,
): UntrackedDiscordSnapshotAttachment[] {
  const rows = db
    .query(
      `SELECT DISTINCT
         e.id AS event_id,
         json_extract(file.value, '$.id') AS source_id,
         json_extract(file.value, '$.url') AS original_uri,
         json_extract(file.value, '$.filename') AS filename,
         json_extract(file.value, '$.size') AS file_size,
         CASE WHEN json_type(file.value, '$.content_type') = 'text'
           THEN json_extract(file.value, '$.content_type')
           ELSE NULL
         END AS content_type,
         CASE WHEN json_type(file.value, '$.width') IN ('integer', 'real')
           THEN json_extract(file.value, '$.width')
           ELSE NULL
         END AS width,
         CASE WHEN json_type(file.value, '$.height') IN ('integer', 'real')
           THEN json_extract(file.value, '$.height')
           ELSE NULL
         END AS height
       FROM events e
       JOIN json_each(
         CASE WHEN json_valid(e.raw_data) THEN e.raw_data ELSE '{}' END,
         '$.message_snapshots'
       ) snapshot
       JOIN json_each(snapshot.value, '$.message.attachments') file
       LEFT JOIN attachments existing
         ON existing.event_id = e.id
        AND existing.source_id = json_extract(file.value, '$.id')
       WHERE e.source = 'discord'
         AND json_type(file.value, '$.id') = 'text'
         AND json_type(file.value, '$.url') = 'text'
         AND json_type(file.value, '$.filename') = 'text'
         AND json_type(file.value, '$.size') IN ('integer', 'real')
         AND json_extract(file.value, '$.url') LIKE 'https://cdn.discordapp.com/%'
         AND existing.id IS NULL
       ORDER BY e.id, source_id`,
    )
    .all() as UntrackedSnapshotRow[];

  return rows.map((row) => ({
    eventId: row.event_id,
    discordId: row.source_id,
    url: row.original_uri,
    filename: row.filename,
    fileSize: row.file_size,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
  }));
}

/** Register untracked snapshot files so the normal Discord recovery can fetch them. */
export function seedDiscordSnapshotAttachments(
  db: Database,
  attachments: readonly UntrackedDiscordSnapshotAttachment[],
): number {
  const seed = db.transaction((rows: readonly UntrackedDiscordSnapshotAttachment[]) => {
    let inserted = 0;
    for (const attachment of rows) {
      inserted += insertPendingAttachment(db, {
        eventId: attachment.eventId,
        source: "discord",
        sourceId: attachment.discordId,
        filename: attachment.filename,
        mimeType: attachment.contentType ?? getMimeType(attachment.filename),
        fileSize: attachment.fileSize,
        width: attachment.width,
        height: attachment.height,
        originalUri: attachment.url,
      });
    }
    return inserted;
  });
  return seed(attachments);
}

interface AttachmentRow {
  id: number;
  source_id: string;
  content_hash: string | null;
  storage_path: string | null;
  original_uri: string;
  filename: string | null;
  file_size: number | null;
  channel_id: string | null;
}

/**
 * Discord attachments whose blob is absent both locally and in R2 — the rows a
 * backfill would attempt. Read-only. Skips rows already marked `unrecoverable`
 * (a prior run gave up on them) and rows missing the channel id needed to
 * reconstruct the storage path.
 */
export async function findDiscordRecoverySet(
  db: Database,
  local: LocalPresence,
  remote: RemoteBlobStore | null,
): Promise<BackfillCandidate[]> {
  const rows = db
    .query(
      `SELECT a.id, a.source_id, a.content_hash, a.storage_path, a.original_uri, a.filename, a.file_size,
              json_extract(e.raw_data, '$._channel.id') AS channel_id
       FROM attachments a JOIN events e ON a.event_id = e.id
       WHERE a.source = 'discord'
         AND a.original_uri LIKE 'https://cdn.discordapp.com/%'
         AND a.status != 'unrecoverable'
       -- Group correlated failures: losing access to a guild/channel makes its
       -- attachments fail together, so the breaker sees an unbroken streak (and
       -- aborts) rather than tombstones scattered among other channels' successes.
       ORDER BY json_extract(e.raw_data, '$._channel.guild_id'), channel_id, a.id`,
    )
    .all() as AttachmentRow[];

  // One R2 scan for the whole set (vs a HEAD per hash).
  const hashes = new Set<string>();
  for (const r of rows) if (r.content_hash) hashes.add(r.content_hash);
  const inR2 = remote ? await remote.presentHashes(hashes) : new Set<string>();

  const candidates: BackfillCandidate[] = [];
  for (const r of rows) {
    if (!r.channel_id) continue; // can't rebuild the storage path without it
    let present = false;
    if (r.content_hash) {
      // The by-hash blob's extension matches what storeFile derived from the path.
      const ext = extname(r.storage_path ?? r.filename ?? "");
      present = inR2.has(r.content_hash) || (await local.hasHash(r.content_hash, ext));
    }
    if (present) continue;
    candidates.push({
      attachmentId: r.id,
      discordId: r.source_id,
      channelId: String(r.channel_id),
      url: r.original_uri,
      filename: r.filename ?? "unnamed",
      fileSize: r.file_size ?? 0,
    });
  }
  return candidates;
}

/** Re-sign a batch of expired URLs → map(originalUrl → freshUrl); omits any Discord won't refresh. */
export type RefreshFn = (urls: string[]) => Promise<Map<string, string>>;
/** Download the bytes at a (fresh) URL; throws {@link HttpError} on a non-2xx response. */
export type DownloadFn = (url: string) => Promise<Buffer>;
/** Persist recovered bytes (write-through to R2) and return the stored blob's identity. */
export type StoreFn = (candidate: BackfillCandidate, content: Buffer) => Promise<StoreFileResult>;

/** Where the backfill records its results — DB-backed in the CLI, captured in tests. */
export interface BackfillSink {
  /** A blob was recovered: flip the row to `status='stored'` with the new hash/path/size. */
  recordStored(candidate: BackfillCandidate, result: StoreFileResult): void;
  /** These rows are permanently gone: flip them to `status='unrecoverable'`. */
  recordUnrecoverable(attachmentIds: readonly number[]): void;
}

export interface BackfillDeps {
  refresh: RefreshFn;
  download: DownloadFn;
  store: StoreFn;
  sink: BackfillSink;
}

export interface BackfillOptions {
  /** Expired URLs per refresh-urls call (default 50; Discord's documented cap). */
  refreshBatch?: number;
  /** Parallel downloads (default 6). */
  concurrency?: number;
  /**
   * Abort after this many *consecutive* failures (default 25). A healthy run
   * interleaves successes, so an unbroken failure streak signals a systemic
   * problem — bail without tombstoning rather than mark a recoverable corpus dead.
   */
  maxConsecutiveFailures?: number;
  /** Abort once total failures reach this backstop (default 200). */
  maxFailures?: number;
  /** Base backoff for transient retries (default 1000ms; doubles, jittered). */
  retryBaseMs?: number;
  /** Max retries per transient operation (default 5). */
  retryMax?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface BackfillResult {
  /** Candidates considered this run. */
  total: number;
  recovered: number;
  recoveredBytes: number;
  /** Rows flipped to `unrecoverable` (genuine, isolated deletions). */
  unrecoverable: number;
  /** Transient failures left untouched for a later re-run. */
  transientFailures: number;
  aborted: boolean;
  abortReason?: string;
}

type Outcome = { kind: "stored"; result: StoreFileResult } | { kind: "gone" } | { kind: "failed" };

/**
 * Backfill the given candidates. For each refresh-urls batch we download in a
 * bounded pool (transient errors retried with backoff), then walk the batch *in
 * order* to drive the circuit breaker:
 *
 * - A success flushes any buffered tombstones — proof the preceding failures
 *   were isolated, not the leading edge of a systemic break.
 * - A permanent failure (gone) is *buffered*, not written, until such a success.
 * - On abort (consecutive/total threshold, or a 401) the buffer is discarded, so
 *   a systemic cluster marks nothing. Genuine deletions sprinkled among
 *   successes still get tombstoned so re-runs skip them.
 *
 * Effect stays internal; the export is Promise-shaped.
 */
export async function backfillDiscordAttachments(
  candidates: readonly BackfillCandidate[],
  deps: BackfillDeps,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const refreshBatch = options.refreshBatch ?? 50;
  const concurrency = options.concurrency ?? 6;
  const maxConsecutive = options.maxConsecutiveFailures ?? 25;
  const maxFailures = options.maxFailures ?? 200;
  for (const [name, value] of [
    ["refreshBatch", refreshBatch],
    ["concurrency", concurrency],
    ["maxConsecutiveFailures", maxConsecutive],
    ["maxFailures", maxFailures],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer, got ${value}`);
    }
  }

  const retryBaseMs = options.retryBaseMs ?? 1000;
  const retryMax = options.retryMax ?? 5;

  const result: BackfillResult = {
    total: candidates.length,
    recovered: 0,
    recoveredBytes: 0,
    unrecoverable: 0,
    transientFailures: 0,
    aborted: false,
  };

  let consecutive = 0;
  let failures = 0;
  let pendingTombstones: number[] = [];
  let done = 0;

  const flushTombstones = (): void => {
    if (pendingTombstones.length === 0) return;
    deps.sink.recordUnrecoverable(pendingTombstones);
    result.unrecoverable += pendingTombstones.length;
    pendingTombstones = [];
  };

  for (let i = 0; i < candidates.length && !result.aborted; i += refreshBatch) {
    const chunk = candidates.slice(i, i + refreshBatch);

    // Re-sign the batch. 401 stops everything; other failures (after retries)
    // make the whole chunk transient-failed so the breaker can react.
    let refreshed = new Map<string, string>();
    let refreshFailed = false;
    const refreshExit = await Effect.runPromiseExit(
      withHttpRetry(() => deps.refresh(chunk.map((c) => c.url)), retryBaseMs, retryMax),
    );
    if (Exit.isSuccess(refreshExit)) {
      refreshed = refreshExit.value;
    } else if (isAuth(Cause.squash(refreshExit.cause))) {
      result.aborted = true;
      result.abortReason = "refresh-urls returned 401 (token rejected) — aborting, nothing marked";
      break;
    } else {
      refreshFailed = true;
    }

    // Download every refreshable candidate through a sliding-window pool. Each
    // runs to an Exit so one failure never aborts the batch; classified below.
    const refreshable = refreshFailed ? [] : chunk.filter((c) => refreshed.has(c.url));
    const exits = refreshable.length
      ? await Effect.runPromise(
          Effect.forEach(
            refreshable,
            (c) =>
              Effect.gen(function* () {
                const url = refreshed.get(c.url);
                if (!url) return yield* Effect.fail(new HttpError(404, "url omitted by refresh-urls"));
                const bytes = yield* withHttpRetry(() => deps.download(url), retryBaseMs, retryMax);
                return yield* Effect.tryPromise({ try: () => deps.store(c, bytes), catch: (e) => e });
              }).pipe(
                Effect.exit,
                Effect.tap(() =>
                  Effect.sync(() => {
                    done++;
                    options.onProgress?.(done, candidates.length);
                  }),
                ),
              ),
            { concurrency },
          ),
        )
      : [];

    const outcomeByCandidate = new Map<BackfillCandidate, Outcome>();
    refreshable.forEach((c, idx) => {
      const exit = exits[idx];
      if (exit && Exit.isSuccess(exit)) {
        outcomeByCandidate.set(c, { kind: "stored", result: exit.value });
      } else {
        const err = exit ? Cause.squash(exit.cause) : undefined;
        outcomeByCandidate.set(c, { kind: isGone(err) ? "gone" : "failed" });
      }
    });

    // Walk the chunk in order to drive the breaker deterministically.
    for (const c of chunk) {
      const outcome: Outcome = refreshFailed
        ? { kind: "failed" }
        : (outcomeByCandidate.get(c) ?? { kind: "gone" }); // not refreshed = omitted = gone

      if (outcome.kind === "stored") {
        flushTombstones(); // a success confirms the buffered gones were isolated
        deps.sink.recordStored(c, outcome.result);
        result.recovered++;
        result.recoveredBytes += outcome.result.fileSize;
        consecutive = 0;
        continue;
      }

      failures++;
      consecutive++;
      if (outcome.kind === "gone") pendingTombstones.push(c.attachmentId);
      else result.transientFailures++;

      if (consecutive >= maxConsecutive) {
        result.aborted = true;
        result.abortReason = `${consecutive} consecutive failures — likely systemic; aborted without tombstoning`;
        break;
      }
      if (failures >= maxFailures) {
        result.aborted = true;
        result.abortReason = `${failures} total failures (--max-failures) — aborted without tombstoning the remainder`;
        break;
      }
    }
  }

  // Trailing genuine deletions from a clean run are safe to tombstone; a run that
  // aborted leaves its buffered (suspect) tombstones unwritten.
  if (!result.aborted) flushTombstones();
  return result;
}
