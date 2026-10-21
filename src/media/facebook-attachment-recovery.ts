/**
 * Facebook attachment recovery — restore blobs lost (e.g. with a host failure)
 * from the surviving local export, without re-importing.
 *
 * Unlike Discord (re-fetch from a CDN), Facebook media lives in the export on
 * disk. Two export-format generations coexist: older exports store paths like
 * `messages/inbox/<conv>/photos/<id>.jpg`, newer ones prefix them with
 * `your_facebook_activity/`, and each row's `original_uri` is in the format of the
 * export it came from. We resolve each `original_uri` by exact path against the
 * extracted trees (rooted at either marker) AND every ZIP's entries. A relative
 * path can collide across exports/accounts, so every located copy is tried and
 * only the one reproducing the row's recorded content hash is written through the
 * media store (-> R2) — the row stays `status='stored'`. A copy whose bytes don't
 * match is refused, and a located-but-unreadable copy (corrupt archive / I/O) is
 * distinguished from one that's simply absent.
 *
 * Files absent from the indexed local exports are *not* tombstoned; they're left
 * untouched so a later run can recover them if more export archives are added.
 * Effect drives the bounded store pool; the export is Promise-shaped (mirrors
 * src/media/upload.ts).
 */

import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { existsSync, type Dirent } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { extname, join } from "path";
import { Effect, Exit } from "effect";
import { computeHash, type RemoteBlobStore, type StoreFileResult } from "./storage";
import { backgroundCommand } from "../lib/background-priority";

export interface FacebookCandidate {
  attachmentId: number;
  /** The export-relative path recorded at import time (resolution key). */
  originalUri: string;
  /** storeFile relativePath = the existing storage_path minus its `facebook/` prefix, or `<conversation>/<filename>` for never-stored (pending) rows. */
  relativePath: string;
  /** Recorded size from the row (0 if unknown) — for reporting only. */
  fileSize: number;
  /** The row's recorded content hash; recovered bytes must reproduce it (null = no prior hash to check). */
  expectedHash: string | null;
}

const MESSAGE_CATEGORIES = new Set([
  "inbox",
  "archived_threads",
  "filtered_threads",
  "message_requests",
  "e2ee_cutover",
]);

/**
 * storeFile relativePath for a row that has never been stored: the export's
 * conversation folder plus the filename, matching how stored rows' paths were
 * derived (non-conversation media like stickers_used land under `unknown/`;
 * the by-hash store dedupes regardless, this only names the hardlink).
 */
export function relativePathForUri(originalUri: string): string {
  const parts = originalUri.split("/");
  const filename = parts[parts.length - 1] || originalUri;
  const categoryIndex = parts.findIndex((p) => MESSAGE_CATEGORIES.has(p));
  const folder =
    categoryIndex >= 0 && parts[categoryIndex + 1] && categoryIndex + 1 < parts.length - 1
      ? parts[categoryIndex + 1]
      : "unknown";
  return join(folder, filename);
}

/** The slice of a local store the recovery-set scan reads through. */
export interface LocalPresence {
  hasHash(hash: string, ext: string): Promise<boolean>;
}

interface FacebookRow {
  id: number;
  content_hash: string | null;
  storage_path: string | null;
  original_uri: string;
  file_size: number | null;
}

/**
 * Facebook attachments whose blob is absent both locally and in R2 — the rows a
 * recovery would attempt. Read-only. Skips rows already tombstoned. Covers both
 * stored-but-lost rows (relativePath reproduced from storage_path) and
 * never-stored `pending` registrations (no storage_path yet — relativePath
 * derived from original_uri).
 */
export async function findFacebookRecoverySet(
  db: Database,
  local: LocalPresence,
  remote: RemoteBlobStore | null,
): Promise<FacebookCandidate[]> {
  const rows = db
    .query(
      `SELECT id, content_hash, storage_path, original_uri, file_size
       FROM attachments
       WHERE source = 'facebook' AND status != 'unrecoverable'
         AND original_uri IS NOT NULL
       ORDER BY id`,
    )
    .all() as FacebookRow[];

  const hashes = new Set<string>();
  for (const r of rows) if (r.content_hash) hashes.add(r.content_hash);
  const inR2 = remote ? await remote.presentHashes(hashes) : new Set<string>();

  const candidates: FacebookCandidate[] = [];
  for (const r of rows) {
    const relativePath = r.storage_path
      ? r.storage_path.replace(/^facebook\//, "")
      : relativePathForUri(r.original_uri);
    let present = false;
    if (r.content_hash) {
      present = inR2.has(r.content_hash) || (await local.hasHash(r.content_hash, extname(relativePath)));
    }
    if (present) continue;
    candidates.push({
      attachmentId: r.id,
      originalUri: r.original_uri,
      relativePath,
      fileSize: r.file_size ?? 0,
      expectedHash: r.content_hash,
    });
  }
  return candidates;
}

/** The bytes (if any) an export-relative path resolves to, and how it went. */
export interface FacebookReadResult {
  /** How many export locations the path resolved to (0 = genuinely absent). */
  located: number;
  /** Successfully-read candidate buffers (one per readable location). */
  candidates: Buffer[];
  /** Located but unreadable (corrupt archive / permissions / I/O) — not "absent". */
  readErrors: number;
}

/** Resolves an attachment's export-relative path to bytes in the local export. */
export interface FacebookSource {
  /** Extracted-tree roots (joined with original_uri) — for reporting. */
  roots: string[];
  /** Distinct ZIP entries indexed — for reporting. */
  zipEntries: number;
  /** Whether the export contains this path anywhere (cheap; for the dry-run split). */
  locate(originalUri: string): boolean;
  /** Whether a target content hash was found under any export path. */
  locateHash(hash: string): boolean;
  /**
   * Read every location the path resolves to. A path can legitimately collide
   * across exports/accounts (same relative URI, different bytes), so we return all
   * readable candidates for the caller to match against the recorded hash, and
   * count locations that failed to read separately from a path that's simply absent.
   */
  read(originalUri: string): Promise<FacebookReadResult>;
  /** Read every export entry indexed as reproducing this recorded content hash. */
  readHash(hash: string): Promise<FacebookReadResult>;
  /**
   * Build a content-hash fallback index for recorded hashes. Only entries whose
   * uncompressed size matches a target are read; hashless/size-less rows are
   * never guessed.
   */
  indexHashes(candidates: readonly FacebookCandidate[]): Promise<FacebookHashIndexResult>;
}

export interface FacebookHashIndexResult {
  targetHashes: number;
  indexableHashes: number;
  unindexableHashes: number;
  hashedEntries: number;
  hashedBytes: number;
  matchedHashes: number;
  matchedEntries: number;
}

interface ZipEntry {
  path: string;
  size: number;
}

function parseZipLongListing(text: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  for (const line of text.split("\n")) {
    const match =
      /^([dl-])[rwx-]{9}\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(
        line,
      );
    if (!match || match[1] === "d" || match[3].endsWith("/")) continue;
    entries.push({ path: match[3], size: Number(match[2]) });
  }
  return entries;
}

async function hashStream(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
  label: string,
): Promise<string> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hash.update(chunk.value);
    bytes += chunk.value.byteLength;
  }
  if (bytes !== expectedSize) {
    throw new Error(`Read ${bytes} bytes for ${label}; ZIP listing reported ${expectedSize}`);
  }
  return hash.digest("hex");
}

/**
 * Index the local export once: directories holding an extracted
 * `your_facebook_activity` tree (resolved by path join) plus every ZIP's entries
 * (one listing per ZIP, so a later read opens a single archive rather than
 * scanning all of them per attachment).
 */
export async function buildFacebookSource(exportPath: string): Promise<FacebookSource> {
  const roots: string[] = [];
  const zips: string[] = [];

  // A directory holding an extracted export tree is a resolution root (its files
  // resolve by join(root, original_uri)). Both export generations are recognised:
  // newer exports wrap everything in `your_facebook_activity/`, older ones have
  // `messages/` (and siblings) at the top, and a row's original_uri is in the
  // format of the export it came from. Stop descending at a root — it covers its
  // whole subtree — and otherwise keep looking for roots + export ZIPs.
  const rootMarkers = new Set(["your_facebook_activity", "messages"]);
  async function scan(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir
    }
    const isRoot = entries.some((e) => e.isDirectory() && rootMarkers.has(e.name));
    if (isRoot) roots.push(dir);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isRoot) await scan(join(dir, entry.name));
      } else if (entry.name.endsWith(".zip")) {
        zips.push(join(dir, entry.name));
      }
    }
  }
  await scan(exportPath);

  // An entry can exist in more than one ZIP — keep them all so the caller can try
  // each against the recorded hash rather than committing to the first.
  const zipsByEntry = new Map<string, string[]>();
  const entriesByZip = new Map<string, string[]>();
  const unreadableZips: string[] = [];
  for (const zip of zips) {
    const proc = Bun.spawn(backgroundCommand(["unzip", "-Z1", zip]), { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      // A corrupt/unreadable archive contributes no entries; silently ignoring it
      // would misreport its attachments as absent. Fail fast so the broken export
      // is fixed rather than papered over.
      unreadableZips.push(zip);
      continue;
    }
    const zipEntries: string[] = [];
    for (const line of text.split("\n")) {
      const entry = line.trim();
      if (!entry || entry.endsWith("/")) continue;
      zipEntries.push(entry);
      const list = zipsByEntry.get(entry);
      if (list) list.push(zip);
      else zipsByEntry.set(entry, [zip]);
    }
    entriesByZip.set(zip, zipEntries);
  }
  if (unreadableZips.length > 0) {
    throw new Error(
      `Could not list ${unreadableZips.length} export ZIP(s) — corrupt/unreadable; their attachments would be miscounted as absent:\n  ${unreadableZips.join("\n  ")}`,
    );
  }
  if (roots.length === 0 && zips.length === 0) {
    throw new Error(`No Facebook export found at ${exportPath} (no extracted tree or ZIPs)`);
  }

  const zipLoader = (zip: string, entry: string): (() => Promise<Buffer>) =>
    async () => {
      const proc = Bun.spawn(backgroundCommand(["unzip", "-p", zip, entry]), { stdout: "pipe", stderr: "ignore" });
      const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      if ((await proc.exited) !== 0) throw new Error(`unzip failed for ${entry} in ${zip}`);
      return buf;
    };

  /** Every place `uri` could be read from — extracted files first, then ZIP entries. */
  const loaders = (uri: string): (() => Promise<Buffer>)[] => {
    const out: (() => Promise<Buffer>)[] = [];
    for (const root of roots) {
      const path = join(root, uri);
      if (existsSync(path)) out.push(() => readFile(path));
    }
    for (const zip of zipsByEntry.get(uri) ?? []) {
      out.push(zipLoader(zip, uri));
    }
    return out;
  };

  const hashLoaders = new Map<string, (() => Promise<Buffer>)[]>();

  const readLoaders = async (load: (() => Promise<Buffer>)[]): Promise<FacebookReadResult> => {
    const candidates: Buffer[] = [];
    let readErrors = 0;
    for (const fn of load) {
      try {
        candidates.push(await fn());
      } catch {
        readErrors++;
      }
    }
    return { located: load.length, candidates, readErrors };
  };

  return {
    roots,
    zipEntries: zipsByEntry.size,
    locate: (uri) => loaders(uri).length > 0,
    locateHash: (hash) => (hashLoaders.get(hash)?.length ?? 0) > 0,
    read: (uri) => readLoaders(loaders(uri)),
    readHash: (hash) => readLoaders(hashLoaders.get(hash) ?? []),
    indexHashes: async (candidates) => {
      hashLoaders.clear();

      const targetHashes = new Set<string>();
      const indexableHashes = new Set<string>();
      const hashesBySize = new Map<number, Set<string>>();
      for (const candidate of candidates) {
        if (!candidate.expectedHash) continue;
        targetHashes.add(candidate.expectedHash);
        if (candidate.fileSize <= 0) continue;
        indexableHashes.add(candidate.expectedHash);
        const hashes = hashesBySize.get(candidate.fileSize);
        if (hashes) hashes.add(candidate.expectedHash);
        else hashesBySize.set(candidate.fileSize, new Set([candidate.expectedHash]));
      }

      if (hashesBySize.size === 0) {
        return {
          targetHashes: targetHashes.size,
          indexableHashes: indexableHashes.size,
          unindexableHashes: targetHashes.size - indexableHashes.size,
          hashedEntries: 0,
          hashedBytes: 0,
          matchedHashes: 0,
          matchedEntries: 0,
        };
      }

      let hashedEntries = 0;
      let hashedBytes = 0;
      let matchedEntries = 0;

      const indexMatch = (
        hash: string,
        size: number,
        loader: () => Promise<Buffer>,
      ): void => {
        if (!hashesBySize.get(size)?.has(hash)) return;
        const existing = hashLoaders.get(hash);
        if (existing) existing.push(loader);
        else hashLoaders.set(hash, [loader]);
        matchedEntries++;
      };

      const hashExtractedTree = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            await hashExtractedTree(path);
            continue;
          }
          if (!entry.isFile()) continue;
          const fileStat = await stat(path);
          if (!hashesBySize.has(fileStat.size)) continue;
          const digest = await hashStream(Bun.file(path).stream(), fileStat.size, path);
          hashedEntries++;
          hashedBytes += fileStat.size;
          indexMatch(digest, fileStat.size, () => readFile(path));
        }
      };

      for (const root of roots) await hashExtractedTree(root);

      for (const zip of zips) {
        const proc = Bun.spawn(backgroundCommand(["unzip", "-Z", "-l", zip]), {
          stdout: "pipe",
          stderr: "ignore",
        });
        const text = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) {
          throw new Error(`Could not size-list export ZIP ${zip}`);
        }
        const zipEntries = parseZipLongListing(text);
        const expectedEntries = entriesByZip.get(zip)?.length ?? 0;
        if (zipEntries.length !== expectedEntries) {
          throw new Error(
            `Could not parse ZIP size listing for ${zip}: expected ${expectedEntries} files, parsed ${zipEntries.length}`,
          );
        }
        for (const entry of zipEntries) {
          if (!hashesBySize.has(entry.size)) continue;
          const hashProc = Bun.spawn(backgroundCommand(["unzip", "-p", zip, entry.path]), {
            stdout: "pipe",
            stderr: "ignore",
          });
          const digest = await hashStream(
            hashProc.stdout,
            entry.size,
            `${zip}::${entry.path}`,
          );
          if ((await hashProc.exited) !== 0) {
            throw new Error(`unzip failed while hashing ${entry.path} in ${zip}`);
          }
          hashedEntries++;
          hashedBytes += entry.size;
          indexMatch(digest, entry.size, zipLoader(zip, entry.path));
        }
      }

      return {
        targetHashes: targetHashes.size,
        indexableHashes: indexableHashes.size,
        unindexableHashes: targetHashes.size - indexableHashes.size,
        hashedEntries,
        hashedBytes,
        matchedHashes: hashLoaders.size,
        matchedEntries,
      };
    },
  };
}

export type FacebookStoreFn = (candidate: FacebookCandidate, content: Buffer) => Promise<StoreFileResult>;

export interface FacebookRecoverySink {
  /** A blob was recovered: refresh the row's hash/path/size (status stays 'stored'). */
  recordStored(candidate: FacebookCandidate, result: StoreFileResult): void;
}

export interface FacebookRecoveryDeps {
  /** Resolve an original_uri to its export locations' bytes (see FacebookReadResult). Must not reject. */
  read: (originalUri: string) => Promise<FacebookReadResult>;
  /**
   * Resolve a recorded content hash under renamed/moved export paths. Hashless
   * candidates never call this fallback.
   */
  readHash?: (hash: string) => Promise<FacebookReadResult>;
  store: FacebookStoreFn;
  sink: FacebookRecoverySink;
}

export interface FacebookRecoveryOptions {
  /** Parallel store operations (default 6). */
  concurrency?: number;
  /**
   * Abort once this many *store* errors accrue (default 50). A store failure is a
   * systemic disk/R2 problem, not a missing file — bail so we don't grind the
   * whole corpus against a broken backend. A not-found file never counts here.
   */
  maxFailures?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface FacebookRecoveryResult {
  total: number;
  recovered: number;
  recoveredBytes: number;
  /** Resolved nowhere in the indexed exports — left untouched, not tombstoned. */
  notFound: number;
  /** Located but unreadable (corrupt archive / permissions / I/O) — left for a re-run, NOT counted as absent. */
  readFailed: number;
  /** Located + readable, but no candidate reproduced the row's hash (wrong/colliding source) — not persisted. */
  mismatched: number;
  /** Store errors (disk/R2) — left for a re-run. */
  failed: number;
  aborted: boolean;
  abortReason?: string;
}

/**
 * Recover the given candidates: read each from the local export and, if a located
 * copy reproduces the row's recorded hash, write it through the media store.
 * Outcomes are split so an exit-success doesn't hide a problem: `notFound`
 * (absent from indexed exports), `readFailed` (located but unreadable),
 * `mismatched` (readable but wrong bytes), `failed` (store error). Each of the latter three
 * aborts past `maxFailures` (a systemic signal). Idempotent/resumable — a re-run
 * recomputes the still-missing set. Effect drives the concurrency pool; the export
 * is Promise-shaped.
 */
export async function recoverFacebookAttachments(
  candidates: readonly FacebookCandidate[],
  deps: FacebookRecoveryDeps,
  options: FacebookRecoveryOptions = {},
): Promise<FacebookRecoveryResult> {
  const concurrency = options.concurrency ?? 6;
  const maxFailures = options.maxFailures ?? 50;
  for (const [name, value] of [
    ["concurrency", concurrency],
    ["maxFailures", maxFailures],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
  }

  const result: FacebookRecoveryResult = {
    total: candidates.length,
    recovered: 0,
    recoveredBytes: 0,
    notFound: 0,
    readFailed: 0,
    mismatched: 0,
    failed: 0,
    aborted: false,
  };
  let done = 0;

  /** Trip the soft-abort once a failure category clusters (a systemic signal). */
  const abortIf = (count: number, reason: string): void => {
    if (count >= maxFailures && !result.aborted) {
      result.aborted = true;
      result.abortReason = reason;
    }
  };

  await Effect.runPromise(
    Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          if (result.aborted) return; // soft abort: let in-flight finish, skip the rest
          const found = yield* Effect.promise(() =>
            deps.read(candidate.originalUri).catch(() => ({ located: 0, candidates: [], readErrors: 0 })),
          );
          // Pick the located copy that reproduces the row's recorded hash. Trying
          // every candidate matters because a relative URI can collide across
          // exports/accounts; refusing to persist a non-matching blob is what stops
          // a wrong/extra export from overwriting the row with the wrong bytes.
          // Rows without a prior hash accept the first readable copy.
          const expectedHash = candidate.expectedHash;
          let chosen = expectedHash
            ? found.candidates.find((b) => computeHash(b) === expectedHash)
            : found.candidates[0];
          let fallback: FacebookReadResult | null = null;
          if (!chosen && expectedHash && deps.readHash) {
            const readHash = deps.readHash;
            fallback = yield* Effect.promise(() =>
              readHash(expectedHash).catch(() => ({
                located: 0,
                candidates: [],
                readErrors: 0,
              })),
            );
            // Re-hash the bytes read for persistence instead of trusting the
            // earlier index: the archive may have changed between the two reads.
            chosen = fallback.candidates.find(
              (b) => computeHash(b) === expectedHash,
            );
          }
          if (!chosen) {
            const located = found.located + (fallback?.located ?? 0);
            const readErrors = found.readErrors + (fallback?.readErrors ?? 0);
            if (located === 0) {
              result.notFound++; // absent from both exact-path and hash indexes
              return;
            }
            // Located but unusable. If any copy failed to read, the matching one may
            // be the unreadable one — treat as a (retryable) read failure rather
            // than a definitive mismatch.
            if (readErrors > 0) {
              result.readFailed++;
              abortIf(result.readFailed, `${result.readFailed} read failures — aborting (corrupt export / I/O?)`);
            } else {
              result.mismatched++;
              abortIf(result.mismatched, `${result.mismatched} hash mismatches — aborting (wrong --export-path?)`);
            }
            return;
          }
          const exit = yield* Effect.exit(Effect.tryPromise({ try: () => deps.store(candidate, chosen), catch: (e) => e }));
          if (Exit.isSuccess(exit)) {
            deps.sink.recordStored(candidate, exit.value);
            result.recovered++;
            result.recoveredBytes += exit.value.fileSize;
          } else {
            result.failed++;
            abortIf(result.failed, `${result.failed} store failures — aborting (systemic disk/R2 issue?)`);
          }
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              done++;
              options.onProgress?.(done, candidates.length);
            }),
          ),
        ),
      { concurrency },
    ),
  );
  return result;
}
