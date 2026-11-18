import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_QUIET_WINDOW_MS, fileFingerprint } from "./file-checkpoints";

it("detects ctime changes with every other fingerprint field identical", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "file-fingerprint-"));
  const path = join(root, "log.jsonl");
  await fs.writeFile(path, "aaaa");
  const metadata = await fs.stat(path, { bigint: true });
  // Hold nanosecond mtime exactly fixed, rather than rounding it through Date.
  metadata.mtimeNs = 1n;
  metadata.ctimeNs = 1n;
  const stat = spyOn(fs, "stat").mockResolvedValue(metadata);
  try {
    const before = await fileFingerprint(path);
    await fs.writeFile(path, "bbbb");
    metadata.ctimeNs = 2n;
    const after = await fileFingerprint(path);
    expect(before?.checkpointable).toBe(true);
    expect(after?.checkpointable).toBe(true);
    expect(after?.value).not.toBe(before?.value);
  } finally { stat.mockRestore(); await fs.rm(root, { recursive: true }); }
});

it("only checkpoints when both timestamps are older than the quiet window", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "file-fingerprint-"));
  const path = join(root, "log.jsonl");
  await fs.writeFile(path, "aaaa");
  const metadata = await fs.stat(path, { bigint: true });
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const stat = spyOn(fs, "stat").mockResolvedValue(metadata);
  const cutoff = BigInt(now - CHECKPOINT_QUIET_WINDOW_MS) * 1_000_000n;
  try {
    for (const field of ["mtimeNs", "ctimeNs"] as const) {
      for (const timestamp of [cutoff, BigInt(now) * 1_000_000n, BigInt(now + 60_000) * 1_000_000n]) {
        metadata.mtimeNs = metadata.ctimeNs = cutoff - 1n;
        metadata[field] = timestamp;
        expect((await fileFingerprint(path))?.checkpointable).toBe(false);
      }
    }
    metadata.mtimeNs = metadata.ctimeNs = cutoff - 1n;
    expect((await fileFingerprint(path))?.checkpointable).toBe(true);
  } finally { stat.mockRestore(); clock.mockRestore(); await fs.rm(root, { recursive: true }); }
});
