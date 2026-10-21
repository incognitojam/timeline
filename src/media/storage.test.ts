import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { getAbsolutePath, getMediaStore, storeFile } from "./storage";

let mediaRoot: string;
let outside: string;
let priorMediaPath: string | undefined;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "storage-test-"));
  mediaRoot = join(base, "media");
  outside = join(base, "outside");
  priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
  process.env.TIMELINE_MEDIA_PATH = mediaRoot;
});

afterEach(() => {
  if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
  else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
  const root = resolve(mediaRoot, "..");
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("storeFile path containment", () => {
  test("stores a normal relative path inside the media root", async () => {
    const result = await storeFile({
      source: "discord",
      relativePath: "channel/msg/photo.jpg",
      content: Buffer.from("hello"),
    });
    expect(result.storagePath).toBe("discord/channel/msg/photo.jpg");
    expect(existsSync(join(mediaRoot, result.storagePath))).toBe(true);
  });

  test("rejects relativePath that traverses out of the media root", async () => {
    await expect(
      storeFile({
        source: "discord",
        relativePath: "channel/msg/../../../../../etc/passwd",
        content: Buffer.from("pwned"),
      }),
    ).rejects.toThrow(/outside media root/);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(mediaRoot)).toBe(false);
  });

  test("rejects relativePath that escapes via a sibling directory", async () => {
    await expect(
      storeFile({
        source: "discord",
        relativePath: `../../outside/payload.bin`,
        content: Buffer.from("pwned"),
      }),
    ).rejects.toThrow(/outside media root/);
    expect(existsSync(outside)).toBe(false);
  });

  test("rejects traversal injected via source", async () => {
    await expect(
      storeFile({
        source: "../outside",
        relativePath: "cron.d/payload",
        content: Buffer.from("pwned"),
      }),
    ).rejects.toThrow(/outside media root/);
    expect(existsSync(outside)).toBe(false);
  });

  test("does not leak files when traversal is attempted", async () => {
    try {
      await storeFile({
        source: "discord",
        relativePath: "../../../tmp-leak-target",
        content: Buffer.from("pwned"),
      });
    } catch {
      // expected
    }
    expect(existsSync(resolve(mediaRoot, "..", "..", "..", "tmp-leak-target"))).toBe(false);
  });
});

describe("storeFile content-addressed storage", () => {
  test("writes content under by-hash sharded by 2-char prefix and hardlinks the source path", async () => {
    const content = Buffer.from([0, 1, 2, 3]);
    const expectedHash = createHash("sha256").update(content).digest("hex");

    const result = await storeFile({
      source: "discord",
      relativePath: "ch/msg/img.png",
      content,
    });

    expect(result.hash).toBe(expectedHash);
    expect(result.fileSize).toBe(content.length);
    expect(result.deduplicated).toBe(false);
    expect(result.storagePath).toBe("discord/ch/msg/img.png");

    const byHashPath = join(mediaRoot, "by-hash", expectedHash.slice(0, 2), `${expectedHash}.png`);
    const sourcePath = join(mediaRoot, result.storagePath);

    expect(existsSync(byHashPath)).toBe(true);
    expect(existsSync(sourcePath)).toBe(true);
    // Hardlink: both paths reference the same inode.
    expect(statSync(sourcePath).ino).toBe(statSync(byHashPath).ino);
    expect(readFileSync(sourcePath)).toEqual(content);
  });

  test("deduplicates identical content across two source paths", async () => {
    const content = Buffer.from("shared payload");

    const first = await storeFile({
      source: "discord",
      relativePath: "ch/msg-a/file.bin",
      content,
    });
    const second = await storeFile({
      source: "discord",
      relativePath: "ch/msg-b/file.bin",
      content,
    });

    expect(first.hash).toBe(second.hash);
    expect(second.deduplicated).toBe(true);

    const pathA = join(mediaRoot, first.storagePath);
    const pathB = join(mediaRoot, second.storagePath);
    // Both source paths share the inode with the by-hash file.
    expect(statSync(pathA).ino).toBe(statSync(pathB).ino);
  });

  test("reads a stored local file through the media store", async () => {
    const content = Buffer.from("local read payload");
    const stored = await storeFile({
      source: "discord",
      relativePath: "ch/msg/file.txt",
      content,
    });

    const file = await (await getMediaStore()).readFile(stored.storagePath);

    expect(file).not.toBeNull();
    expect(file?.absolutePath).toBe(join(mediaRoot, stored.storagePath));
    expect(file?.fileSize).toBe(content.length);
    expect(Buffer.from(file?.content ?? new ArrayBuffer(0))).toEqual(content);
  });

  test("is idempotent under concurrent same-path writes (restore race)", async () => {
    // Duplicate browser requests after a cache miss drive concurrent restores
    // of the same blob into the same source path; none should fail with EEXIST.
    const content = Buffer.from("concurrent restore payload");
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        storeFile({ source: "discord", relativePath: "c/1/a.txt", content }),
      ),
    );

    for (const r of results) expect(r.hash).toBe(results[0].hash);
    const file = await (await getMediaStore()).readFile(results[0].storagePath);
    expect(Buffer.from(file?.content ?? new ArrayBuffer(0))).toEqual(content);
  });

  test("rejects resolved storage paths that escape the media root", async () => {
    await expect(getAbsolutePath("../outside/payload.bin")).rejects.toThrow(/outside media root/);
  });
});
