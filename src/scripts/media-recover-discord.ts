#!/usr/bin/env bun
/**
 * Discord attachment recovery.
 *
 *   bun run media-recover-discord            # DRY RUN — reports the plan, fetches nothing
 *   bun run media-recover-discord --execute  # refresh URLs, download, write through to R2
 *
 * Re-downloads Discord attachment blobs that are missing both locally and in R2
 * (e.g. lost with a host failure). The stored CDN URLs are long expired, so we
 * re-sign them in batches via `attachments/refresh-urls`, download, and write
 * through the media store. Each row flips back to `status='stored'`; permanently
 * gone messages are tombstoned `status='unrecoverable'` so re-runs skip them.
 * Forwarded snapshot files omitted by older sync code are registered first and
 * then pass through the same recovery pipeline.
 *
 * Writes to the timeline DB (unlike the read-only media-* CLIs) — short per-row
 * updates that coexist with the live service via WAL + busy_timeout. Idempotent
 * and resumable: a re-run recomputes what's still missing. Bails without
 * tombstoning if failures cluster (likely systemic) — see attachment-backfill.ts.
 */

import { Database } from "bun:sqlite";
import { parseArgs } from "util";
import { loadConfig } from "../config";
import { assertNoLocalDbMarker, getDbPathInfo } from "../db/paths";
import { openReadonlyDbAtPath } from "../db/readonly";
import { markAttachmentStored } from "../media/attachments";
import { LocalMediaStore, storeFile } from "../media/storage";
import { createR2BlobStore } from "../media/r2";
import { formatBinaryBytes } from "../lib/format";
import { safeFileName } from "../platforms/discord/attachment-downloader";
import {
  backfillDiscordAttachments,
  findDiscordRecoverySet,
  findUntrackedDiscordSnapshotAttachments,
  HttpError,
  seedDiscordSnapshotAttachments,
  type BackfillCandidate,
  type BackfillDeps,
  type BackfillSink,
} from "../platforms/discord/attachment-backfill";

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got ${value}`);
  return n;
}

/** Extract a 429's Retry-After (seconds) as ms, so retries honor the server's window. */
function retryAfterMs(res: Response): number | undefined {
  if (res.status !== 429) return undefined;
  const header = res.headers.get("Retry-After") ?? res.headers.get("X-RateLimit-Reset-After");
  const seconds = header ? Number.parseFloat(header) : Number.NaN;
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
}

/** Re-sign a batch of expired URLs via Discord; throws HttpError on a non-2xx. */
async function refreshUrls(token: string, urls: string[]): Promise<Map<string, string>> {
  const res = await fetch("https://discord.com/api/v9/attachments/refresh-urls", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ attachment_urls: urls }),
  });
  if (!res.ok) throw new HttpError(res.status, `refresh-urls HTTP ${res.status}`, retryAfterMs(res));
  const body = (await res.json()) as { refreshed_urls?: { original: string; refreshed: string }[] };
  const map = new Map<string, string>();
  for (const e of body.refreshed_urls ?? []) if (e.refreshed) map.set(e.original, e.refreshed);
  return map;
}

/** Download bytes from a (fresh) URL; throws HttpError on a non-2xx. */
async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(res.status, `download HTTP ${res.status}`, retryAfterMs(res));
  return Buffer.from(await res.arrayBuffer());
}

/** Open the timeline DB read/write (the recovery updates rows), with WAL + busy_timeout. */
function openWritableDbAtPath(dbPath: string): Database {
  const info = getDbPathInfo(dbPath);
  assertNoLocalDbMarker(info, info.resolvedDbPath, "database");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 30000");
  return db;
}

function makeSink(db: Database): BackfillSink {
  const tombstone = db.transaction((ids: readonly number[]) => {
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      db.query(`UPDATE attachments SET status = 'unrecoverable' WHERE id IN (${slice.map(() => "?").join(",")})`).run(
        ...slice,
      );
    }
  });
  return {
    recordStored: (c: BackfillCandidate, r) =>
      markAttachmentStored(db, c.attachmentId, r),
    recordUnrecoverable: (ids: readonly number[]) => {
      if (ids.length > 0) tombstone(ids);
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      execute: { type: "boolean" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      "max-consecutive-failures": { type: "string" },
      "max-failures": { type: "string" },
    },
    allowPositionals: true,
  });
  const execute = values.execute ?? false;
  const limit = parsePositiveInt(values.limit, "limit");
  const concurrency = parsePositiveInt(values.concurrency, "concurrency");
  const maxConsecutiveFailures = parsePositiveInt(values["max-consecutive-failures"], "max-consecutive-failures");
  const maxFailures = parsePositiveInt(values["max-failures"], "max-failures");
  const token = execute ? process.env.DISCORD_TOKEN : undefined;
  if (execute && !token) throw new Error("DISCORD_TOKEN not set — required to refresh Discord CDN URLs");

  const config = await loadConfig();
  const local = new LocalMediaStore(config.media.path);
  const remote = config.media.r2?.enabled ? createR2BlobStore(config.media.r2) : null;
  if (!remote) {
    throw new Error("[media.r2] not enabled — recovery needs R2 to know which blobs are durable vs missing");
  }

  // Dry run only reads (recovery-set classification); open writable only to execute.
  const db = execute ? openWritableDbAtPath(config.database.path) : openReadonlyDbAtPath(config.database.path);
  try {
    console.log(
      execute ? "Discord attachment recovery" : "Discord attachment recovery plan (dry run) — fetches nothing",
    );
    const untracked = findUntrackedDiscordSnapshotAttachments(db);
    if (execute && untracked.length > 0) {
      const seeded = seedDiscordSnapshotAttachments(db, untracked);
      console.log(`  registered forwarded snapshot attachments: ${seeded}`);
    }

    let candidates = await findDiscordRecoverySet(db, local, remote);
    if (limit !== undefined) candidates = candidates.slice(0, limit);

    const totalBytes = candidates.reduce((sum, c) => sum + c.fileSize, 0);
    const channels = new Set(candidates.map((c) => c.channelId)).size;
    console.log(`  recoverable: ${candidates.length} attachments, ${formatBinaryBytes(totalBytes)} across ${channels} channels`);
    if (!execute && untracked.length > 0) {
      const untrackedBytes = untracked.reduce((sum, attachment) => sum + attachment.fileSize, 0);
      console.log(
        `  untracked forwarded snapshot attachments: ${untracked.length}, ${formatBinaryBytes(untrackedBytes)} (registered on --execute)`,
      );
    }

    if (!execute) {
      console.log("  (run with --execute to refresh URLs, download, and write through to R2)");
      return;
    }
    if (candidates.length === 0) return;
    if (!token) throw new Error("DISCORD_TOKEN not set — required to refresh Discord CDN URLs");

    const deps: BackfillDeps = {
      refresh: (urls) => refreshUrls(token, urls),
      download,
      store: (c, content) =>
        storeFile({
          source: "discord",
          relativePath: `${c.channelId}/${c.discordId}/${safeFileName(c.filename)}`,
          content,
        }),
      sink: makeSink(db),
    };

    let lastLogged = 0;
    const result = await backfillDiscordAttachments(candidates, deps, {
      concurrency,
      maxConsecutiveFailures,
      maxFailures,
      onProgress: (done, total) => {
        if (done - lastLogged >= 500 || done === total) {
          lastLogged = done;
          console.log(`  …${done}/${total}`);
        }
      },
    });

    console.log(`  recovered:   ${result.recovered} attachments, ${formatBinaryBytes(result.recoveredBytes)}`);
    console.log(`  unrecoverable (tombstoned): ${result.unrecoverable}`);
    console.log(`  transient failures (left for re-run): ${result.transientFailures}`);
    if (result.aborted) {
      console.error(`ABORTED: ${result.abortReason}`);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
