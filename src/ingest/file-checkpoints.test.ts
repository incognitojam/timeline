import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileFingerprint } from "./file-checkpoints";

it("hashes a recent file even when a rewrite has identical stat metadata", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "file-fingerprint-"));
  const path = join(root, "log.jsonl");
  await fs.writeFile(path, "aaaa");
  const metadata = await fs.stat(path, { bigint: true });
  const clock = spyOn(Date, "now").mockReturnValue(Number(metadata.ctimeNs / 1_000_000n));
  const stat = spyOn(fs, "stat").mockResolvedValue(metadata);
  try {
    const before = await fileFingerprint(path);
    await fs.writeFile(path, "bbbb");
    expect(await fileFingerprint(path)).not.toBe(before);
    expect(await fileFingerprint(path)).toBe(await fileFingerprint(path));
  } finally { stat.mockRestore(); clock.mockRestore(); await fs.rm(root, { recursive: true }); }
});
