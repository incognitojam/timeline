import { createPrivateKey } from "node:crypto";

export function validateUpdateKey(encoded: string, expectedPublicKey: string): void {
  const secret = Buffer.from(encoded, "base64");
  if (secret.length !== 32 || secret.toString("base64") !== encoded) {
    throw new Error("The update signing secret must be an exported Sparkle seed (32 bytes, base64 encoded)");
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), secret]),
    format: "der", type: "pkcs8",
  });
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("Could not derive the update signing public key");
  const publicKey = Buffer.from(jwk.x, "base64url");
  if (publicKey.toString("base64") !== expectedPublicKey) {
    throw new Error("The update signing secret does not match the public key embedded in the app");
  }
}

if (import.meta.main) {
  const secret = process.env.SPARKLE_ED_PRIVATE_KEY;
  const publicKey = process.argv[2];
  if (!secret || !publicKey) throw new Error("Update signing requires a secret and the app's public key");
  validateUpdateKey(secret, publicKey);
}
