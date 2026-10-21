import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { LocalMediaStore, computeHash, type RemoteBlobStore } from "./storage";
import { uploadLocalMedia } from "./upload";

class FakeRemote implements RemoteBlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  putCalls = 0;
  constructor(seedHashes: string[] = []) {
    for (const h of seedHashes) this.blobs.set(h, new Uint8Array());
  }
  async put(hash: string, content: Uint8Array): Promise<void> {
    this.blobs.set(hash, Uint8Array.from(content));
    this.putCalls++;
  }
  async has(hash: string) {
    return this.blobs.has(hash);
  }
  async get(hash: string) {
    const v = this.blobs.get(hash);
    return v ? Buffer.from(v) : null;
  }
  async presentHashes(hashes: Iterable<string>) {
    const r = new Set<string>();
    for (const h of hashes) if (this.blobs.has(h)) r.add(h);
    return r;
  }
}

function seedDb(): { db: Database; eventId: number } {
  const db = new Database(":memory:");
  initDb(db);
  const evt = db
    .query("INSERT INTO events (source, source_account, type, raw_data, conversation_id) VALUES ('discord', 'tester', 'message:dm', '{}', 'upload-test-thread') RETURNING id")
    .get() as { id: number };
  return { db, eventId: evt.id };
}

describe("uploadLocalMedia", () => {
  const roots: string[] = [];
  const newRoot = () => {
    const d = mkdtempSync(join(tmpdir(), "upload-"));
    roots.push(d);
    return d;
  };
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  // X: local + already in R2 · Y: local, not in R2 (the upload target) · Z: in DB
  // but no local file (recovery territory — must not be "uploaded").
  async function fixture() {
    const local = new LocalMediaStore(newRoot());
    const x = await local.storeFile({ source: "discord", relativePath: "a/x.png", content: Buffer.from("X-bytes") });
    const y = await local.storeFile({ source: "discord", relativePath: "a/y.png", content: Buffer.from("Y-bytes") });
    const zHash = computeHash(Buffer.from("Z-bytes"));

    const { db, eventId } = seedDb();
    const att = db.prepare(
      "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, file_size, status) VALUES (?, 'discord', ?, ?, ?, ?, 'stored')",
    );
    att.run(eventId, "x", x.hash, "discord/a/x.png", 7);
    att.run(eventId, "y", y.hash, "discord/a/y.png", 7);
    att.run(eventId, "z", zHash, "discord/a/z.png", 7);

    return { local, db, x, y, remote: new FakeRemote([x.hash]) };
  }

  test("dry run reports the upload set and writes nothing", async () => {
    const { local, db, remote } = await fixture();
    const result = await uploadLocalMedia(db, local, remote, { dryRun: true });
    db.close();

    expect(result.dryRun).toBe(true);
    expect(result.alreadyInR2).toBe(1); // X
    expect(result.toUpload).toBe(1); // Y only (X present, Z not local)
    expect(result.toUploadBytes).toBe(7);
    expect(result.uploaded).toBe(0);
    expect(remote.putCalls).toBe(0);
  });

  test("execute uploads local-only blobs (the real bytes) and is idempotent", async () => {
    const { local, db, y, remote } = await fixture();

    const first = await uploadLocalMedia(db, local, remote, { dryRun: false });
    expect(first.uploaded).toBe(1);
    expect(first.failed).toBe(0);
    expect(remote.putCalls).toBe(1);
    expect(Buffer.from(remote.blobs.get(y.hash) ?? new Uint8Array()).equals(Buffer.from("Y-bytes"))).toBe(true);

    // Re-run: Y is now in R2, so there is nothing left to upload.
    const second = await uploadLocalMedia(db, local, remote, { dryRun: false });
    db.close();
    expect(second.toUpload).toBe(0);
    expect(second.uploaded).toBe(0);
    expect(remote.putCalls).toBe(1); // no further puts
  });

  test("respects the limit", async () => {
    const { local, db, remote } = await fixture();
    const result = await uploadLocalMedia(db, local, remote, { dryRun: false, limit: 0 });
    db.close();
    expect(result.toUpload).toBe(1); // still reports the full pending set
    expect(result.uploaded).toBe(0); // but uploads none this run
    expect(remote.putCalls).toBe(0);
  });

  test("rejects invalid concurrency/limit before doing work", async () => {
    const { local, db, remote } = await fixture();
    try {
      await expect(uploadLocalMedia(db, local, remote, { concurrency: 0 })).rejects.toThrow(/concurrency/);
      await expect(uploadLocalMedia(db, local, remote, { concurrency: Number("x") })).rejects.toThrow(/concurrency/);
      await expect(uploadLocalMedia(db, local, remote, { limit: -1 })).rejects.toThrow(/limit/);
      await expect(uploadLocalMedia(db, local, remote, { retryMax: -1 })).rejects.toThrow(/retryMax/);
      await expect(uploadLocalMedia(db, local, remote, { retryBaseMs: -1 })).rejects.toThrow(/retryBaseMs/);
      expect(remote.putCalls).toBe(0);
    } finally {
      db.close();
    }
  });

  test("counts a failed upload instead of aborting the run", async () => {
    const { local, db, remote } = await fixture();
    remote.put = async () => {
      throw new Error("boom");
    };
    const result = await uploadLocalMedia(db, local, remote, { dryRun: false, retryBaseMs: 1 });
    db.close();
    expect(result.failed).toBe(1);
    expect(result.uploaded).toBe(0);
  });

  test("retries a transient throttle error then succeeds", async () => {
    const { local, db, y, remote } = await fixture();
    let attempts = 0;
    remote.put = async (hash: string, content: Uint8Array) => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("slow down"), { name: "S3Error", code: "SlowDown" });
      }
      remote.blobs.set(hash, Uint8Array.from(content));
    };
    const result = await uploadLocalMedia(db, local, remote, { dryRun: false, retryBaseMs: 1 });
    db.close();
    expect(attempts).toBe(2); // failed once, retried, succeeded
    expect(result.uploaded).toBe(1);
    expect(result.failed).toBe(0);
    expect(Buffer.from(remote.blobs.get(y.hash) ?? new Uint8Array()).equals(Buffer.from("Y-bytes"))).toBe(true);
  });

  test("does not retry a permanent error", async () => {
    const { local, db, remote } = await fixture();
    let attempts = 0;
    remote.put = async () => {
      attempts++;
      throw Object.assign(new Error("denied"), { name: "S3Error", code: "AccessDenied" });
    };
    const result = await uploadLocalMedia(db, local, remote, { dryRun: false, retryBaseMs: 1 });
    db.close();
    expect(attempts).toBe(1); // no retry
    expect(result.failed).toBe(1);
  });

  test("gives up after retryMax on persistent throttling", async () => {
    const { local, db, remote } = await fixture();
    let attempts = 0;
    remote.put = async () => {
      attempts++;
      throw Object.assign(new Error("slow"), { name: "S3Error", code: "SlowDown" });
    };
    const result = await uploadLocalMedia(db, local, remote, { dryRun: false, retryBaseMs: 1, retryMax: 2 });
    db.close();
    expect(attempts).toBe(3); // initial + 2 retries
    expect(result.failed).toBe(1);
  });
});
