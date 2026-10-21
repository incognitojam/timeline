/**
 * Media Encryption (client-side, for offsite object storage)
 *
 * Personal media (Recall screen captures, private DMs) must never reach a
 * third-party store as plaintext. This module encrypts blobs before upload so
 * the remote backend (e.g. R2) only ever holds ciphertext.
 *
 * The scheme is *keyed deterministic* so content-addressed dedup survives:
 * identical plaintext yields byte-identical ciphertext, yet every derivation is
 * gated on a secret master key, so it is NOT vulnerable to the classic
 * convergent-encryption confirmation-of-file attack. All three derived values
 * (object key, data key, nonce) use distinct HKDF/HMAC domain-separation labels
 * keyed by (masterKey, contentHash). Because the AES-GCM key and nonce are both
 * derived from the content hash, a given (key, nonce) pair only ever encrypts
 * the one plaintext whose SHA-256 produced it — a reuse would require a SHA-256
 * collision.
 *
 * Residual leak (accepted): the remote sees object sizes, counts, upload timing,
 * and dup-equality (a consequence of deterministic encryption). It cannot read
 * bytes or correlate object keys to content without the master key.
 */

import { createHmac, hkdfSync, createCipheriv, createDecipheriv, timingSafeEqual } from "crypto";
import { computeHash } from "./storage";

/** Bytes in the AES-256 key. */
const KEY_BYTES = 32;
/** Bytes in the AES-GCM nonce (96-bit, the GCM-recommended size). */
const NONCE_BYTES = 12;
/** Bytes in the AES-GCM authentication tag. */
const TAG_BYTES = 16;

/**
 * Object payload format version. A 1-byte prefix lets the scheme evolve
 * (e.g. a future envelope mode) without ambiguity when decrypting old objects.
 */
const FORMAT_VERSION = 1;

/**
 * HKDF/HMAC domain-separation labels. Versioned so the derivation can change
 * without colliding with material derived under an older scheme.
 */
const SALT = Buffer.from("timeline-media-v1");
const LABEL_OBJKEY = "timeline-media/v1/objkey/";
const LABEL_DATAKEY = "timeline-media/v1/datakey/";
const LABEL_NONCE = "timeline-media/v1/nonce/";

/**
 * Parse and validate a master key from its base64 env representation (e.g.
 * `openssl rand -base64 32`). Fail-fast: a missing or malformed key must crash
 * at init, never silently disable encryption. `envVarName` names the variable
 * in error messages so callers reusing this for other secrets (e.g. the offsite
 * backup key) get an accurate diagnostic; it defaults to the media key.
 */
export function parseMasterKey(
  base64: string | undefined,
  envVarName = "MEDIA_ENCRYPTION_KEY",
): Buffer {
  if (!base64) {
    throw new Error(
      `${envVarName} is required for encrypted offsite storage but is not set. ` +
        "Generate one with `openssl rand -base64 32` and store it in ~/.config/timeline/env " +
        "(back it up to a password manager — losing it makes the offsite copy unrecoverable).",
    );
  }
  // Node's base64 decoder is lenient — it silently drops invalid characters —
  // so a typo'd key could decode to 32 bytes and be wrongly accepted. Re-encode
  // the decoded bytes and require an exact match to reject non-canonical input.
  const trimmed = base64.trim();
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${envVarName} must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }
  if (key.toString("base64") !== trimmed) {
    throw new Error(`${envVarName} is not valid canonical base64`);
  }
  return key;
}

function hkdf(masterKey: Buffer, label: string, contentHash: string, length: number): Buffer {
  // hkdfSync returns an ArrayBuffer; wrap without copying.
  return Buffer.from(hkdfSync("sha256", masterKey, SALT, label + contentHash, length));
}

/**
 * Derive the AES-256-GCM key and nonce for a given content hash. Distinct
 * labels guarantee the key material and the nonce are independent draws.
 */
function deriveCipherParams(masterKey: Buffer, contentHash: string): {
  dataKey: Buffer;
  nonce: Buffer;
} {
  return {
    dataKey: hkdf(masterKey, LABEL_DATAKEY, contentHash, KEY_BYTES),
    nonce: hkdf(masterKey, LABEL_NONCE, contentHash, NONCE_BYTES),
  };
}

/**
 * Remote object key for a blob, derived as HMAC(masterKey, label || contentHash).
 * Keyed by the secret, so it reveals nothing about the content (not even
 * possession of a known file), yet is deterministic so duplicate plaintext maps
 * to one object. Sharded by a 2-char prefix to avoid a single flat namespace.
 */
export function objectKeyFor(masterKey: Buffer, contentHash: string): string {
  const mac = createHmac("sha256", masterKey)
    .update(LABEL_OBJKEY + contentHash)
    .digest("hex");
  return `${mac.slice(0, 2)}/${mac}`;
}

/**
 * Encrypt a blob. Output layout: version(1) || tag(16) || ciphertext. The nonce
 * is not stored — it is re-derived from (masterKey, contentHash) on decrypt.
 */
export function encryptBlob(
  masterKey: Buffer,
  contentHash: string,
  plaintext: Buffer | Uint8Array,
): Buffer {
  const { dataKey, nonce } = deriveCipherParams(masterKey, contentHash);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), tag, body]);
}

/**
 * Decrypt a blob produced by {@link encryptBlob}. Throws on tag mismatch
 * (tamper/wrong key), unknown version, or if the recovered plaintext does not
 * hash to the expected contentHash.
 */
export function decryptBlob(
  masterKey: Buffer,
  contentHash: string,
  payload: Buffer | Uint8Array,
): Buffer {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length < 1 + TAG_BYTES) {
    throw new Error("Encrypted media payload is too short");
  }
  const version = buf[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported encrypted media format version: ${version}`);
  }
  const tag = buf.subarray(1, 1 + TAG_BYTES);
  const body = buf.subarray(1 + TAG_BYTES);

  const { dataKey, nonce } = deriveCipherParams(masterKey, contentHash);
  const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);

  // Belt-and-suspenders: the GCM tag already authenticates the ciphertext, but
  // verifying the plaintext hashes back to the claimed identity also catches a
  // wrong contentHash being paired with this object.
  const actual = Buffer.from(computeHash(plaintext), "hex");
  const expected = Buffer.from(contentHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Decrypted media does not match its content hash");
  }
  return plaintext;
}

/**
 * Power-on self-test: encrypt then decrypt a fixed probe to prove the cipher
 * and key derivation round-trip with this master key. Run when the encrypted
 * backend is constructed, so a crypto regression fails loudly at startup —
 * before any unrecoverable ciphertext is written offsite — rather than on the
 * first read. It cannot detect a key that is merely *wrong* for already-stored
 * data (encrypt and decrypt are self-consistent here); it guards the
 * implementation, not key provenance.
 */
export function assertEncryptionRoundTrips(masterKey: Buffer): void {
  const probe = Buffer.from("timeline media self-test");
  const hash = computeHash(probe);
  const restored = decryptBlob(masterKey, hash, encryptBlob(masterKey, hash, probe));
  if (!restored.equals(probe)) {
    throw new Error("Media encryption self-test failed (round-trip mismatch)");
  }
}
