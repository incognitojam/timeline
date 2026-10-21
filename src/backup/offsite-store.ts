/**
 * Encrypted offsite backup store (Cloudflare R2).
 *
 * Uploads whole-database SQLite snapshots to R2 as single encrypted objects so
 * a host loss can't take the databases with it — the offsite leg of 3-2-1
 * backups. It reuses the in-app keyed-AES-256-GCM crypto (see ../media/crypto),
 * but NOT the content-addressed dedup model: a DB snapshot is one immutable
 * artifact, so each upload is a distinct object under a human-readable,
 * self-describing key:
 *
 *   <prefix>/<ISO-timestamp>__<sha256>.db.enc
 *
 * The snapshot's SHA-256 lives in the key, and that hash is exactly the
 * contentHash the crypto layer derives its data key + nonce from. So the bucket
 * alone is restorable with just the encryption key — no external manifest. That
 * matters because the disaster scenario is losing the host AND both DBs, so a
 * manifest stored only in app-state.db would be gone too. The ISO timestamp
 * prefix sorts lexicographically by age, which is what {@link prune} relies on.
 *
 * Encryption uses BACKUP_ENCRYPTION_KEY (not the media key) for blast-radius
 * isolation: rotating one key never orphans the other store's ciphertext.
 *
 * Accepted leak: anyone who can list the bucket sees backup timestamps, sizes,
 * and plaintext SHA-256s — but listing already requires the R2 credentials, and
 * a personal DB snapshot isn't a confirmation-attack target the way common
 * media is.
 */

import { readFileSync } from "node:fs";
import type { R2Config } from "../config/types";
import { encryptBlob, parseMasterKey, assertEncryptionRoundTrips } from "../media/crypto";
import { computeHash } from "../media/storage";

/** Result of uploading one snapshot. */
export interface BackupUpload {
  key: string;
  /** SHA-256 of the plaintext snapshot (also embedded in the key). */
  sha256: string;
  /** Ciphertext size in bytes. */
  size: number;
}

/**
 * The slice of Bun's S3 client this store relies on. Declaring it explicitly
 * lets tests inject an in-memory double instead of reaching the network; a real
 * `Bun.S3Client` satisfies it structurally. (Reads — `file()` — arrive with the
 * restore tooling; this PR only writes, lists, and prunes.)
 */
export interface BackupS3Like {
  write(key: string, data: Uint8Array): Promise<number>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; continuationToken?: string }): Promise<{
    contents?: { key: string; size?: number }[];
    isTruncated?: boolean;
    nextContinuationToken?: string;
  }>;
}

const KEY_SUFFIX = ".db.enc";
/** Separates the timestamp segment from the hex SHA-256 in an object key. */
const KEY_SEP = "__";
/**
 * Matches the trailing `<sep><64-hex sha256><suffix>` that {@link backupObjectKey}
 * writes. Built from the same constants so the writer and the recognizer can't drift.
 */
const BACKUP_KEY_RE = new RegExp(`${KEY_SEP}[0-9a-f]{64}${KEY_SUFFIX.replace(/[.]/g, "\\.")}$`);

/** Build the self-describing object key for a snapshot. */
export function backupObjectKey(prefix: string, date: Date, sha256: string): string {
  // Match the local-backup filename style (colons/dots → dashes) so the
  // timestamp is filesystem-safe and sorts lexicographically by age.
  const timestamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}/${timestamp}${KEY_SEP}${sha256}${KEY_SUFFIX}`;
}

/**
 * Whether a key is one of our snapshot objects. Retention scans every key under
 * the prefix, so this guards {@link BackupOffsiteStore.prune} from ever deleting
 * a foreign object that merely shares the prefix (a marker, a future metadata
 * file, a stray upload).
 */
export function isBackupObjectKey(key: string): boolean {
  return BACKUP_KEY_RE.test(key);
}

export class BackupOffsiteStore {
  constructor(
    private readonly client: BackupS3Like,
    private readonly masterKey: Buffer,
  ) {}

  /**
   * Encrypt and upload a snapshot file under `<prefix>/…`. The snapshot is read
   * fully into memory (callers use this for small DBs — see backup-offsite for
   * the size assumption), hashed, then encrypted with that hash as contentHash.
   */
  async upload(prefix: string, snapshotPath: string, now = new Date()): Promise<BackupUpload> {
    const plaintext = readFileSync(snapshotPath);
    const sha256 = computeHash(plaintext);
    const key = backupObjectKey(prefix, now, sha256);
    const ciphertext = encryptBlob(this.masterKey, sha256, plaintext);
    await this.client.write(key, ciphertext);
    return { key, sha256, size: ciphertext.length };
  }

  /**
   * List our snapshot object keys under `<prefix>/`, oldest first. Keys that
   * don't match the snapshot format are skipped so retention never touches a
   * foreign object sharing the prefix.
   */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.list({ prefix: `${prefix}/`, continuationToken });
      for (const obj of page.contents ?? []) {
        if (isBackupObjectKey(obj.key)) keys.push(obj.key);
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
    // Keys lead with an ISO timestamp, so lexicographic order == chronological.
    return keys.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Delete the oldest snapshots under `<prefix>/`, keeping the newest
   * `keepCount`. Returns the keys deleted.
   */
  async prune(prefix: string, keepCount: number): Promise<string[]> {
    const keys = await this.list(prefix); // oldest first
    const removable = Math.max(0, keys.length - Math.max(0, keepCount));
    const deleted: string[] = [];
    for (const key of keys.slice(0, removable)) {
      await this.client.delete(key);
      deleted.push(key);
    }
    return deleted;
  }
}

/**
 * Build a {@link BackupOffsiteStore} from config + env secrets. Fail-fast:
 * throws if the bucket/account or any secret (`R2_ACCESS_KEY_ID`,
 * `R2_SECRET_ACCESS_KEY`, `BACKUP_ENCRYPTION_KEY`) is missing, rather than
 * silently disabling encryption or offsite storage. Runs the crypto self-test
 * so a broken key/cipher setup fails at construction, not mid-upload.
 */
export function createBackupOffsiteStore(config: R2Config): BackupOffsiteStore {
  if (!config.account_id) {
    throw new Error("[backup.r2].account_id is required when backup R2 is enabled");
  }
  if (!config.bucket) {
    throw new Error("[backup.r2].bucket is required when backup R2 is enabled");
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required when backup R2 is enabled " +
        "(export them or set them in ~/.config/timeline/env)",
    );
  }

  const masterKey = parseMasterKey(process.env.BACKUP_ENCRYPTION_KEY, "BACKUP_ENCRYPTION_KEY");
  assertEncryptionRoundTrips(masterKey);

  const client = new Bun.S3Client({
    accessKeyId,
    secretAccessKey,
    bucket: config.bucket,
    endpoint: `https://${config.account_id}.r2.cloudflarestorage.com`,
    region: "auto",
  });

  return new BackupOffsiteStore(client, masterKey);
}
