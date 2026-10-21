/**
 * Media Storage Utility
 *
 * Content-addressed storage for media files with deduplication.
 * Files are stored in by-hash/ directory and hardlinked to source-specific paths.
 */

import { existsSync } from "fs";
import { mkdir, link, stat, unlink } from "fs/promises";
import { join, dirname, extname, resolve, sep } from "path";
import { createHash } from "crypto";
import { loadConfig, type MediaConfig } from "../config";
import { putRemoteBlobWithRetry, type MediaUploadRetryOptions } from "./upload-retry";

export interface StoreFileOptions {
  /** Source name (e.g., "facebook", "discord") */
  source: string;
  /** Relative path within source (e.g., "conversation_123/photo.jpg") */
  relativePath: string;
  /** File content as Buffer or Uint8Array */
  content: Buffer | Uint8Array;
  /** Optional pre-computed hash to skip hashing */
  hash?: string;
}

export interface StoreFileResult {
  /** SHA-256 content hash */
  hash: string;
  /** Relative path to stored file (from media root) */
  storagePath: string;
  /** File size in bytes */
  fileSize: number;
  /** Whether this was a duplicate (file already existed) */
  deduplicated: boolean;
}

export interface StoredMediaFile {
  /** Absolute local filesystem path used for local-only processors */
  absolutePath: string;
  /** File content */
  content: ArrayBuffer;
  /** File size in bytes */
  fileSize: number;
}

export interface MediaStore {
  storeFile(options: StoreFileOptions): Promise<StoreFileResult>;
  hasHash(hash: string, ext: string): Promise<boolean>;
  getAbsolutePath(storagePath: string): string;
  readFile(storagePath: string): Promise<StoredMediaFile | null>;
  /**
   * Restore a file the local cache is missing from the durable backend,
   * repopulating the local cache so subsequent reads are served locally.
   * Returns null when there is no backend or the blob is absent remotely.
   * `contentHash` is the remote key (storage paths are local-only) and is
   * provided by the caller from the serving row (e.g. `attachments` or
   * `discord_emojis`).
   */
  restoreFromRemote(storagePath: string, contentHash: string): Promise<StoredMediaFile | null>;
  /**
   * Read a file's bytes from the local cache, or from the durable backend
   * without adding it to the cache, for one-off processing of many files that
   * would otherwise evict the cache's working set. Null when absent from both.
   */
  readUncached(storagePath: string, contentHash: string): Promise<Buffer | null>;
}

/**
 * A durable backend keyed purely by content hash (e.g. encrypted R2). Unlike
 * {@link MediaStore} it has no notion of the local browsable layout — the hash
 * is the only identity that crosses the host boundary.
 */
export interface RemoteBlobStore {
  /** Upload a blob for the given content hash (no-op-safe to repeat). */
  put(contentHash: string, content: Uint8Array): Promise<void>;
  /** Whether a blob for the given content hash already exists remotely. */
  has(contentHash: string): Promise<boolean>;
  /** Fetch and decrypt a blob, or null if absent. */
  get(contentHash: string): Promise<Buffer | null>;
  /**
   * Which of the given content hashes are present remotely. Bulk membership for
   * inventory/upload/eviction — far cheaper than a `has` per hash at corpus
   * scale (one backend scan vs. tens of thousands of round-trips).
   */
  presentHashes(hashes: Iterable<string>): Promise<Set<string>>;
}

/**
 * Compute SHA-256 hash of content
 */
export function computeHash(content: Buffer | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Get the path in by-hash/ for a given hash and extension
 */
function getHashPath(hash: string, ext: string): string {
  const prefix = hash.slice(0, 2);
  return join("by-hash", prefix, `${hash}${ext}`);
}

function assertWithinMediaRoot(mediaRoot: string, absPath: string): void {
  const resolvedRoot = resolve(mediaRoot);
  const resolved = resolve(absPath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new Error(
      `Refusing to write outside media root: ${resolved} (root: ${resolvedRoot})`,
    );
  }
}

export class LocalMediaStore implements MediaStore {
  constructor(private readonly mediaRoot: string) {}

  /**
   * Store a file with content-addressed deduplication.
   *
   * Files are stored in by-hash/{prefix}/{hash}.{ext} and hardlinked
   * to {source}/{relativePath} for browsability.
   */
  async storeFile(options: StoreFileOptions): Promise<StoreFileResult> {
    const { source, relativePath, content } = options;

    // Compute hash if not provided
    const hash = options.hash ?? computeHash(content);
    const ext = extname(relativePath);
    const fileSize = content.length;

    // Paths relative to media root
    const hashRelPath = getHashPath(hash, ext);
    const sourceRelPath = join(source, relativePath);

    // Absolute paths
    const hashAbsPath = this.getAbsolutePath(hashRelPath);
    const sourceAbsPath = this.getAbsolutePath(sourceRelPath);

    let deduplicated = false;

    // Check if hash file exists
    try {
      await stat(hashAbsPath);
      deduplicated = true;
    } catch {
      // File doesn't exist, write it
      await mkdir(dirname(hashAbsPath), { recursive: true });
      await Bun.write(hashAbsPath, content);
    }

    // Hardlink the source path to the hash file. Content-addressed storage means
    // concurrent restores of the same blob (e.g. duplicate browser requests
    // after a cache miss) race here, so make it idempotent rather than
    // unlink-then-link (which leaves an EEXIST window). Link first; on EEXIST,
    // accept an existing link to the same content (same inode) or replace one
    // that points elsewhere.
    await mkdir(dirname(sourceAbsPath), { recursive: true });
    try {
      await link(hashAbsPath, sourceAbsPath);
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      const [target, existing] = await Promise.all([
        stat(hashAbsPath),
        stat(sourceAbsPath).catch(() => null),
      ]);
      if (!existing || existing.ino !== target.ino) {
        await unlink(sourceAbsPath).catch(() => {});
        await link(hashAbsPath, sourceAbsPath);
      }
    }

    return {
      hash,
      storagePath: sourceRelPath,
      fileSize,
      deduplicated,
    };
  }

  /**
   * Check if a file with the given hash already exists.
   */
  async hasHash(hash: string, ext: string): Promise<boolean> {
    const hashPath = this.getAbsolutePath(getHashPath(hash, ext));

    try {
      await stat(hashPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the content-addressed blob for a (hash, ext) straight from by-hash/,
   * or null if it isn't stored. Lets the upload push an existing local blob
   * without resolving a storage path.
   */
  async readByHash(hash: string, ext: string): Promise<Buffer | null> {
    const hashPath = this.getAbsolutePath(getHashPath(hash, ext));
    if (!existsSync(hashPath)) return null;
    return Buffer.from(await Bun.file(hashPath).arrayBuffer());
  }

  /**
   * On-disk size and mtime of the by-hash blob for a (hash, ext), or null if
   * absent. `mtimeMs` is the cache clock used by eviction: write-through and
   * restore-on-read both rewrite the file, so it reflects when the blob was last
   * brought into the cache.
   */
  async statByHash(hash: string, ext: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const s = await stat(this.getAbsolutePath(getHashPath(hash, ext)));
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * Evict a content blob by removing EVERY local hardlink to it: the given
   * source `storagePaths`, then the by-hash file for each `exts`. Only when the
   * last link is gone is the inode's disk reclaimed. Missing files are ignored
   * (idempotent / re-runnable); any other error is thrown so the caller counts
   * the blob as failed.
   *
   * Order matters: the by-hash file is how the eviction planner discovers a
   * blob (`statByHash`), so it must be removed LAST. If a source unlink fails
   * after the by-hash file is gone, the remaining source hardlink would orphan
   * disk the planner can no longer see (un-retryable). So delete sources first
   * and bail before touching the by-hash anchor if any of them fail.
   */
  async removeBlob(hash: string, exts: string[], storagePaths: string[]): Promise<void> {
    const unlinkAll = async (relPaths: string[]): Promise<unknown[]> => {
      const errors: unknown[] = [];
      for (const rel of relPaths) {
        try {
          await unlink(this.getAbsolutePath(rel));
        } catch (err) {
          if ((err as { code?: string }).code !== "ENOENT") errors.push(err);
        }
      }
      return errors;
    };

    const sourceErrors = await unlinkAll(storagePaths);
    if (sourceErrors.length > 0) {
      // Leave the by-hash anchor in place so the blob stays selectable next run.
      throw new AggregateError(sourceErrors, `failed to remove ${sourceErrors.length} source link(s) for ${hash}`);
    }
    const hashErrors = await unlinkAll(exts.map((ext) => getHashPath(hash, ext)));
    if (hashErrors.length > 0) {
      throw new AggregateError(hashErrors, `failed to remove ${hashErrors.length} by-hash link(s) for ${hash}`);
    }
  }

  /**
   * Get the absolute local path to a stored file.
   */
  getAbsolutePath(storagePath: string): string {
    const absPath = join(this.mediaRoot, storagePath);
    assertWithinMediaRoot(this.mediaRoot, absPath);
    return absPath;
  }

  /**
   * Read a stored local file. Returns null when the path is inside the media
   * root but the file does not exist.
   */
  async readFile(storagePath: string): Promise<StoredMediaFile | null> {
    const absolutePath = this.getAbsolutePath(storagePath);
    if (!existsSync(absolutePath)) {
      return null;
    }

    const file = Bun.file(absolutePath);
    return {
      absolutePath,
      content: await file.arrayBuffer(),
      fileSize: file.size,
    };
  }

  /** A local-only store has no remote backend to restore from. */
  async restoreFromRemote(
    _storagePath: string,
    _contentHash: string,
  ): Promise<StoredMediaFile | null> {
    return null;
  }

  async readUncached(storagePath: string, _contentHash: string): Promise<Buffer | null> {
    const file = await this.readFile(storagePath);
    return file ? Buffer.from(file.content) : null;
  }
}

/**
 * Writes through a local cache to a durable remote backend. Writes land locally
 * first, then the encrypted blob is uploaded; reads are served locally, falling
 * back to the remote (and repopulating the cache) only when the local file is
 * missing.
 */
export class WriteThroughMediaStore implements MediaStore {
  constructor(
    private readonly local: LocalMediaStore,
    private readonly remote: RemoteBlobStore,
    private readonly uploadRetry: MediaUploadRetryOptions = {},
  ) {}

  async storeFile(options: StoreFileOptions): Promise<StoreFileResult> {
    const result = await this.local.storeFile(options);

    // Upload when the content is newly stored locally (fast path, no remote
    // round-trip). When it deduplicated against an existing local blob, confirm
    // the remote actually has it — this covers enabling R2 over a populated
    // cache and retries after a failed upload, without re-uploading known dups.
    if (!result.deduplicated || !(await this.remote.has(result.hash))) {
      const content = Buffer.isBuffer(options.content)
        ? options.content
        : Buffer.from(options.content);
      await putRemoteBlobWithRetry(this.remote, result.hash, content, this.uploadRetry);
    }

    return result;
  }

  hasHash(hash: string, ext: string): Promise<boolean> {
    return this.local.hasHash(hash, ext);
  }

  getAbsolutePath(storagePath: string): string {
    return this.local.getAbsolutePath(storagePath);
  }

  readFile(storagePath: string): Promise<StoredMediaFile | null> {
    return this.local.readFile(storagePath);
  }

  /**
   * Fetch the (decrypted) blob from the remote and repopulate the local cache,
   * so the next read is served locally. Returns null when the remote lacks it.
   */
  async restoreFromRemote(
    storagePath: string,
    contentHash: string,
  ): Promise<StoredMediaFile | null> {
    const content = await this.remote.get(contentHash);
    if (!content) return null;

    // Repopulate the cache (by-hash blob + hardlink) so the next read is local.
    // storagePath is "<source>/<relativePath>"; split on the first separator. A
    // path with no separator can't be stored locally, so just serve the bytes.
    const sep = storagePath.indexOf("/");
    if (sep > 0) {
      await this.local.storeFile({
        source: storagePath.slice(0, sep),
        relativePath: storagePath.slice(sep + 1),
        content,
        hash: contentHash,
      });
    }

    // Serve the bytes we already hold rather than re-reading them from disk
    // (decryptBlob already verified them against contentHash).
    return {
      absolutePath: this.local.getAbsolutePath(storagePath),
      content: content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
      fileSize: content.length,
    };
  }

  async readUncached(storagePath: string, contentHash: string): Promise<Buffer | null> {
    const local = await this.local.readUncached(storagePath, contentHash);
    // decryptBlob verifies the remote bytes against contentHash.
    return local ?? this.remote.get(contentHash);
  }
}

let mediaStoreOverride: MediaStore | null = null;

/**
 * Test-only seam: force {@link getMediaStore} to return this store, so HTTP
 * route tests can exercise the remote read-through path without a real R2
 * backend. Pass null to clear.
 */
export function setMediaStoreOverride(store: MediaStore | null): void {
  mediaStoreOverride = store;
}

export async function getMediaStore(): Promise<MediaStore> {
  if (mediaStoreOverride) return mediaStoreOverride;
  return buildMediaStore((await loadConfig()).media);
}

/**
 * Select the media store for a given media config. Split out from
 * {@link getMediaStore} so the disabled→local and enabled→write-through
 * branches are unit-testable without a config file on disk.
 */
export async function buildMediaStore(media: MediaConfig): Promise<MediaStore> {
  const local = new LocalMediaStore(media.path);
  if (!media.r2?.enabled) return local;

  // Loaded lazily so the S3 client + crypto are only required when R2 is on.
  const { createR2BlobStore } = await import("./r2");
  return new WriteThroughMediaStore(local, createR2BlobStore(media.r2));
}

/**
 * Store a file with content-addressed deduplication
 *
 * Files are stored in by-hash/{prefix}/{hash}.{ext} and hardlinked
 * to {source}/{relativePath} for browsability.
 */
export async function storeFile(options: StoreFileOptions): Promise<StoreFileResult> {
  const store = await getMediaStore();
  return store.storeFile(options);
}

/**
 * Get the absolute path to a stored file
 */
export async function getAbsolutePath(storagePath: string): Promise<string> {
  const store = await getMediaStore();
  return store.getAbsolutePath(storagePath);
}

/**
 * Read a stored file, falling back to the remote backend on a local cache miss.
 * `resolveContentHash` is invoked only on a miss (so local hits stay
 * DB-query-free) and returns the remote key, or null/undefined when unknown.
 * Shared by the media and emoji serve paths so both restore identically.
 */
export async function readOrRestore(
  store: MediaStore,
  storagePath: string,
  resolveContentHash: () => string | null | undefined,
): Promise<StoredMediaFile | null> {
  const local = await store.readFile(storagePath);
  if (local) return local;
  const contentHash = resolveContentHash();
  if (!contentHash) return null;
  return store.restoreFromRemote(storagePath, contentHash);
}

/**
 * Get MIME type from filename extension
 */
export function getMimeType(filename: string): string | null {
  const ext = extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".zip": "application/zip",
    ".txt": "text/plain",
  };
  return mimeTypes[ext] ?? null;
}
