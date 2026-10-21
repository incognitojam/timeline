import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { validateUpdateKey } from "../tools/timeline-app/update-key";

function keyPair() {
  const keys = generateKeyPairSync("ed25519");
  const seed = keys.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { secret: seed.toString("base64"), publicKey: publicKey.toString("base64") };
}

describe("update signing key validation", () => {
  test("accepts matching Sparkle keys", () => {
    const keys = keyPair();
    expect(() => validateUpdateKey(keys.secret, keys.publicKey)).not.toThrow();
  });
  test("rejects malformed secrets without printing them", () => {
    const keys = keyPair();
    expect(() => validateUpdateKey("synthetic-invalid-secret", keys.publicKey)).toThrow("32 bytes");
  });
  test("rejects a different app's public key", () => {
    const keys = keyPair();
    expect(() => validateUpdateKey(keys.secret, keyPair().publicKey)).toThrow("does not match");
  });
  test("rejects a seed concatenated with a public key", () => {
    const keys = keyPair();
    const unsupported = Buffer.concat([Buffer.from(keys.secret, "base64"), Buffer.from(keys.publicKey, "base64")]);
    expect(() => validateUpdateKey(unsupported.toString("base64"), keys.publicKey)).toThrow("32 bytes");
  });
});
