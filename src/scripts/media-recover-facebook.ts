#!/usr/bin/env bun
/**
 * Facebook attachment recovery.
 *
 *   bun run media-recover-facebook            # DRY RUN — reports the plan, writes nothing
 *   bun run media-recover-facebook --execute  # read from the export, write through to R2
 *
 * Stores Facebook attachment blobs missing both locally and in R2 — rows lost
 * with a host failure as well as never-stored `pending` registrations — from
 * the local export at --export-path (default `imports/facebook`). Resolves each
 * row's `original_uri` against the extracted trees + export ZIPs. Stored rows
 * whose export path changed fall back to their recorded SHA-256 content hash;
 * hashless pending rows remain exact-path-only. Recovered bytes are written
 * through the media store. Files absent from the indexed local exports are
 * reported and left untouched — never tombstoned. Writes the timeline DB
 * (short per-row updates, coexists with the live service via WAL + busy_timeout);
 * idempotent/resumable.
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
import {
  buildFacebookSource,
  findFacebookRecoverySet,
  recoverFacebookAttachments,
  type FacebookCandidate,
  type FacebookRecoverySink,
} from "../media/facebook-attachment-recovery";

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got ${value}`);
  return n;
}

/** Open the timeline DB read/write (recovery updates rows), with WAL + busy_timeout. */
function openWritableDbAtPath(dbPath: string): Database {
  const info = getDbPathInfo(dbPath);
  assertNoLocalDbMarker(info, info.resolvedDbPath, "database");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 30000");
  return db;
}

function makeSink(db: Database): FacebookRecoverySink {
  return {
    recordStored: (c: FacebookCandidate, r) =>
      markAttachmentStored(db, c.attachmentId, r),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      execute: { type: "boolean" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      "max-failures": { type: "string" },
      "export-path": { type: "string" },
    },
    allowPositionals: true,
  });
  const execute = values.execute ?? false;
  const limit = parsePositiveInt(values.limit, "limit");
  const concurrency = parsePositiveInt(values.concurrency, "concurrency");
  const maxFailures = parsePositiveInt(values["max-failures"], "max-failures");
  const exportPath = values["export-path"] ?? "imports/facebook";

  const config = await loadConfig();
  const local = new LocalMediaStore(config.media.path);
  const remote = config.media.r2?.enabled ? createR2BlobStore(config.media.r2) : null;
  if (!remote) {
    throw new Error("[media.r2] not enabled — recovery needs R2 to know which blobs are durable vs missing");
  }

  // Dry run only reads (recovery-set classification + locate); writable only to execute.
  const db = execute ? openWritableDbAtPath(config.database.path) : openReadonlyDbAtPath(config.database.path);
  try {
    let candidates = await findFacebookRecoverySet(db, local, remote);
    if (limit !== undefined) candidates = candidates.slice(0, limit);

    console.log(execute ? "Facebook attachment recovery" : "Facebook attachment recovery plan (dry run) — writes nothing");
    console.log(`  missing: ${candidates.length} attachments, ${formatBinaryBytes(candidates.reduce((s, c) => s + c.fileSize, 0))}`);

    // Nothing to do — return before touching the export, so a completed/empty run
    // stays a clean no-op even if imports/facebook is absent (idempotent/resumable).
    if (candidates.length === 0) {
      console.log("  nothing to recover");
      return;
    }

    console.log(`  indexing export at ${exportPath}…`);
    const source = await buildFacebookSource(exportPath);
    console.log(`  export index: ${source.roots.length} extracted root(s), ${source.zipEntries} zip entries`);

    // Build the fallback only for recorded hashes. Size-prefiltering means the
    // export is listed once and only plausible entries are read + hashed.
    const hashIndex = await source.indexHashes(candidates);
    console.log(
      `  hash index: ${hashIndex.matchedHashes}/${hashIndex.targetHashes} target hashes found; ` +
      `${hashIndex.hashedEntries} size-matched entries read (${formatBinaryBytes(hashIndex.hashedBytes)})`,
    );
    if (hashIndex.unindexableHashes > 0) {
      console.log(`  hash index skipped (missing recorded size): ${hashIndex.unindexableHashes} hashes`);
    }

    let exactResolvable = 0;
    let hashResolvable = 0;
    let resolvableBytes = 0;
    for (const c of candidates) {
      if (source.locate(c.originalUri)) {
        exactResolvable++;
        resolvableBytes += c.fileSize;
      } else if (c.expectedHash && source.locateHash(c.expectedHash)) {
        hashResolvable++;
        resolvableBytes += c.fileSize;
      }
    }
    console.log(`  resolvable by exact path: ${exactResolvable}`);
    console.log(`  resolvable by hash fallback: ${hashResolvable}`);
    console.log(`  resolvable recorded bytes: ${formatBinaryBytes(resolvableBytes)}`);
    console.log(`  not found in indexed exports: ${candidates.length - exactResolvable - hashResolvable}`);

    if (!execute) {
      console.log("  (run with --execute to read from the export and write through to R2)");
      return;
    }

    let lastLogged = 0;
    const result = await recoverFacebookAttachments(
      candidates,
      {
        read: (uri) => source.read(uri),
        readHash: (hash) => source.readHash(hash),
        store: (c, content) => storeFile({ source: "facebook", relativePath: c.relativePath, content }),
        sink: makeSink(db),
      },
      {
        concurrency,
        maxFailures,
        onProgress: (doneN, total) => {
          if (doneN - lastLogged >= 1000 || doneN === total) {
            lastLogged = doneN;
            console.log(`  …${doneN}/${total}`);
          }
        },
      },
    );

    console.log(`  recovered:   ${result.recovered} attachments, ${formatBinaryBytes(result.recoveredBytes)}`);
    console.log(`  not found in indexed exports: ${result.notFound}`);
    console.log(`  read failures (corrupt/IO — left for re-run): ${result.readFailed}`);
    console.log(`  hash mismatches (not stored — wrong source?): ${result.mismatched}`);
    console.log(`  store failures (left for re-run): ${result.failed}`);
    if (result.aborted) {
      console.error(`ABORTED: ${result.abortReason}`);
      process.exitCode = 1;
    } else if (result.failed > 0 || result.readFailed > 0 || result.mismatched > 0) {
      // Exit non-zero on the anomalous outcomes (store error / corrupt / wrong
      // bytes) so a partial or degraded run is visible. notFound is excluded — it's
      // the expected persistent remainder after indexing the available exports,
      // not a recovery failure.
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
