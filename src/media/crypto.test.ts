import { describe, test, expect } from "bun:test";
import { randomBytes } from "crypto";
import {
  parseMasterKey,
  objectKeyFor,
  encryptBlob,
  decryptBlob,
  assertEncryptionRoundTrips,
} from "./crypto";
import { computeHash } from "./storage";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

function plaintext(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

function hashOf(pt: Buffer): string {
  return computeHash(pt);
}

describe("parseMasterKey", () => {
  test("accepts a 32-byte base64 key", () => {
    expect(parseMasterKey(KEY_A).length).toBe(32);
  });

  test("throws when missing (fail-fast, no silent disable)", () => {
    expect(() => parseMasterKey(undefined)).toThrow(/MEDIA_ENCRYPTION_KEY is required/);
  });

  test("throws on wrong length", () => {
    const short = randomBytes(16).toString("base64");
    expect(() => parseMasterKey(short)).toThrow(/must decode to 32 bytes/);
  });

  test("rejects non-canonical base64 that the lenient decoder would accept", () => {
    const good = randomBytes(32).toString("base64");
    // Injecting an invalid char that Buffer silently drops still decodes to 32
    // bytes, so only the canonical re-encode check catches it.
    const malformed = `${good.slice(0, 10)}!${good.slice(10)}`;
    expect(parseMasterKey(good).length).toBe(32);
    expect(() => parseMasterKey(malformed)).toThrow(/canonical base64/);
  });

  test("tolerates surrounding whitespace", () => {
    const good = randomBytes(32).toString("base64");
    expect(parseMasterKey(`  ${good}\n`).length).toBe(32);
  });
});

describe("encrypt/decrypt round-trip", () => {
  test("recovers the original plaintext", () => {
    const key = parseMasterKey(KEY_A);
    const pt = plaintext("hello attachment world");
    const ct = encryptBlob(key, hashOf(pt), pt);
    expect(decryptBlob(key, hashOf(pt), ct).equals(pt)).toBe(true);
  });

  test("handles empty and binary content", () => {
    const key = parseMasterKey(KEY_A);
    for (const pt of [Buffer.alloc(0), randomBytes(4096)]) {
      const ct = encryptBlob(key, hashOf(pt), pt);
      expect(decryptBlob(key, hashOf(pt), ct).equals(pt)).toBe(true);
    }
  });
});

describe("determinism (dedup-preserving)", () => {
  test("identical plaintext yields byte-identical ciphertext", () => {
    const key = parseMasterKey(KEY_A);
    const pt = plaintext("same bytes");
    const a = encryptBlob(key, hashOf(pt), pt);
    const b = encryptBlob(key, hashOf(pt), pt);
    expect(a.equals(b)).toBe(true);
  });

  test("identical plaintext yields the same object key", () => {
    const key = parseMasterKey(KEY_A);
    const h = hashOf(plaintext("same bytes"));
    expect(objectKeyFor(key, h)).toBe(objectKeyFor(key, h));
  });
});

describe("isolation between distinct inputs", () => {
  test("different plaintext yields different ciphertext and object key", () => {
    const key = parseMasterKey(KEY_A);
    const p1 = plaintext("alpha");
    const p2 = plaintext("beta");
    expect(encryptBlob(key, hashOf(p1), p1).equals(encryptBlob(key, hashOf(p2), p2))).toBe(false);
    expect(objectKeyFor(key, hashOf(p1))).not.toBe(objectKeyFor(key, hashOf(p2)));
  });

  test("object key depends on the master key (no plaintext-only derivation)", () => {
    const h = hashOf(plaintext("alpha"));
    expect(objectKeyFor(parseMasterKey(KEY_A), h)).not.toBe(objectKeyFor(parseMasterKey(KEY_B), h));
  });

  test("object key is sharded by a 2-char prefix", () => {
    const k = objectKeyFor(parseMasterKey(KEY_A), hashOf(plaintext("alpha")));
    expect(k).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{64}$/);
  });
});

describe("authentication and integrity", () => {
  test("a flipped ciphertext byte fails decryption", () => {
    const key = parseMasterKey(KEY_A);
    const pt = plaintext("tamper me");
    const ct = encryptBlob(key, hashOf(pt), pt);
    ct[ct.length - 1] ^= 0x01;
    expect(() => decryptBlob(key, hashOf(pt), ct)).toThrow();
  });

  test("the wrong master key fails decryption", () => {
    const pt = plaintext("secret");
    const ct = encryptBlob(parseMasterKey(KEY_A), hashOf(pt), pt);
    expect(() => decryptBlob(parseMasterKey(KEY_B), hashOf(pt), ct)).toThrow();
  });

  test("a mismatched content hash is rejected", () => {
    const key = parseMasterKey(KEY_A);
    const pt = plaintext("payload");
    const ct = encryptBlob(key, hashOf(pt), pt);
    const wrongHash = hashOf(plaintext("different"));
    expect(() => decryptBlob(key, wrongHash, ct)).toThrow();
  });

  test("an unknown format version is rejected", () => {
    const key = parseMasterKey(KEY_A);
    const pt = plaintext("payload");
    const ct = encryptBlob(key, hashOf(pt), pt);
    ct[0] = 0xff;
    expect(() => decryptBlob(key, hashOf(pt), ct)).toThrow(/format version/);
  });
});

describe("assertEncryptionRoundTrips (startup self-test)", () => {
  test("passes for a valid key", () => {
    expect(() => assertEncryptionRoundTrips(parseMasterKey(KEY_A))).not.toThrow();
  });
});
