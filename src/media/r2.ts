/**
 * Encrypted R2 blob store.
 *
 * Implements the {@link RemoteBlobStore} seam against Cloudflare R2 (via Bun's
 * S3 client). Every blob is encrypted client-side before upload — R2 only ever
 * holds ciphertext under an opaque, HMAC-derived object key (see ./crypto). The
 * store is keyed purely by content hash; extension, filename, and MIME live in
 * the DB and never leave the host.
 */

import type { RemoteBlobStore } from "./storage";
import type { R2Config } from "../config/types";
import {
  encryptBlob,
  decryptBlob,
  objectKeyFor,
  parseMasterKey,
  assertEncryptionRoundTrips,
} from "./crypto";

/**
 * The slice of Bun's S3 client this store relies on. Declaring it explicitly
 * lets tests inject an in-memory double instead of reaching the network; a real
 * `Bun.S3Client` satisfies it structurally.
 */
export interface S3Like {
  write(key: string, data: Uint8Array): Promise<number>;
  exists(key: string): Promise<boolean>;
  file(key: string): { bytes(): Promise<Uint8Array> };
  list(options?: { continuationToken?: string }): Promise<{
    contents?: { key: string }[];
    isTruncated?: boolean;
    nextContinuationToken?: string;
  }>;
}

export class R2BlobStore implements RemoteBlobStore {
  constructor(
    private readonly client: S3Like,
    private readonly masterKey: Buffer,
  ) {}

  async put(contentHash: string, content: Uint8Array): Promise<void> {
    const ciphertext = encryptBlob(this.masterKey, contentHash, content);
    await this.client.write(objectKeyFor(this.masterKey, contentHash), ciphertext);
  }

  async has(contentHash: string): Promise<boolean> {
    return this.client.exists(objectKeyFor(this.masterKey, contentHash));
  }

  async get(contentHash: string): Promise<Buffer | null> {
    const key = objectKeyFor(this.masterKey, contentHash);
    if (!(await this.client.exists(key))) return null;
    const bytes = await this.client.file(key).bytes();
    return decryptBlob(this.masterKey, contentHash, bytes);
  }

  async presentHashes(hashes: Iterable<string>): Promise<Set<string>> {
    // Map each candidate's opaque object key back to its hash. Object keys are
    // HMAC-derived, so the remote only ever sees opaque keys, never content hashes.
    const keyToHash = new Map<string, string>();
    for (const hash of hashes) {
      keyToHash.set(objectKeyFor(this.masterKey, hash), hash);
    }

    const present = new Set<string>();
    // No candidates → nothing to look for; skip the bucket scan entirely.
    if (keyToHash.size === 0) return present;

    let continuationToken: string | undefined;
    do {
      const page = await this.client.list(
        continuationToken ? { continuationToken } : undefined,
      );
      for (const obj of page.contents ?? []) {
        const hash = keyToHash.get(obj.key);
        if (hash) present.add(hash);
      }
      if (present.size === keyToHash.size) break; // found them all
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);

    return present;
  }
}

/**
 * Build an {@link R2BlobStore} from config + env secrets. Fail-fast: throws if
 * the bucket/account or any secret (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
 * `MEDIA_ENCRYPTION_KEY`) is missing, rather than silently disabling encryption
 * or offsite storage.
 */
export function createR2BlobStore(config: R2Config): RemoteBlobStore {
  if (!config.account_id) {
    throw new Error("[media.r2].account_id is required when R2 is enabled");
  }
  if (!config.bucket) {
    throw new Error("[media.r2].bucket is required when R2 is enabled");
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required when R2 is enabled " +
        "(export them or set them in ~/.config/timeline/env)",
    );
  }

  const masterKey = parseMasterKey(process.env.MEDIA_ENCRYPTION_KEY);
  // Prove the key + cipher round-trip now, so a broken setup fails at
  // construction (and thus at service startup) rather than mid-write.
  assertEncryptionRoundTrips(masterKey);

  const client = new Bun.S3Client({
    accessKeyId,
    secretAccessKey,
    bucket: config.bucket,
    endpoint: `https://${config.account_id}.r2.cloudflarestorage.com`,
    region: "auto",
  });

  return new R2BlobStore(client, masterKey);
}
