import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { R2BlobStore, createR2BlobStore, type S3Like } from "./r2";
import { objectKeyFor, decryptBlob } from "./crypto";
import {
  LocalMediaStore,
  WriteThroughMediaStore,
  buildMediaStore,
  readOrRestore,
  computeHash,
  type RemoteBlobStore,
} from "./storage";

const masterKey = () => Buffer.from(randomBytes(32));

/** In-memory stand-in for the slice of Bun's S3 client R2BlobStore uses. */
class FakeS3 implements S3Like {
  readonly objects = new Map<string, Uint8Array>();

  async write(key: string, data: Uint8Array): Promise<number> {
    this.objects.set(key, Uint8Array.from(data));
    return data.length;
  }
  existsCalls = 0;
  async exists(key: string): Promise<boolean> {
    this.existsCalls++;
    return this.objects.has(key);
  }
  file(key: string) {
    return {
      bytes: async (): Promise<Uint8Array> => {
        const v = this.objects.get(key);
        if (!v) throw new Error(`missing object: ${key}`);
        return v;
      },
    };
  }
  listCalls = 0;
  // Paginated (page size 2) so the presentHashes continuation loop is exercised.
  async list(options?: { continuationToken?: string }) {
    this.listCalls++;
    const keys = [...this.objects.keys()];
    const start = options?.continuationToken ? Number(options.continuationToken) : 0;
    const slice = keys.slice(start, start + 2);
    const next = start + 2;
    const isTruncated = next < keys.length;
    return {
      contents: slice.map((key) => ({ key })),
      isTruncated,
      nextContinuationToken: isTruncated ? String(next) : undefined,
    };
  }
}

describe("R2BlobStore", () => {
  test("stores decryptable ciphertext under the derived object key", async () => {
    const key = masterKey();
    const s3 = new FakeS3();
    const store = new R2BlobStore(s3, key);
    const content = Buffer.from("a private attachment");
    const hash = computeHash(content);

    await store.put(hash, content);

    const stored = s3.objects.get(objectKeyFor(key, hash));
    expect(stored).toBeDefined();
    expect(decryptBlob(key, hash, stored!).equals(content)).toBe(true);
    expect(await store.has(hash)).toBe(true);
  });

  test("stores ciphertext, never plaintext", async () => {
    const s3 = new FakeS3();
    const store = new R2BlobStore(s3, masterKey());
    const content = Buffer.from("SENSITIVE-MARKER-bytes");
    const hash = computeHash(content);

    await store.put(hash, content);
    const stored = [...s3.objects.values()][0];
    expect(Buffer.from(stored).includes(Buffer.from("SENSITIVE-MARKER"))).toBe(false);
    expect(Buffer.from(stored).equals(content)).toBe(false);
  });

  test("has() reports absence", async () => {
    const store = new R2BlobStore(new FakeS3(), masterKey());
    expect(await store.has(computeHash(Buffer.from("never stored")))).toBe(false);
  });

  test("distinct content lands under distinct object keys", async () => {
    const s3 = new FakeS3();
    const store = new R2BlobStore(s3, masterKey());
    await store.put(computeHash(Buffer.from("one")), Buffer.from("one"));
    await store.put(computeHash(Buffer.from("two")), Buffer.from("two"));
    expect(s3.objects.size).toBe(2);
  });

  test("get() round-trips the decrypted blob and reports absence", async () => {
    const store = new R2BlobStore(new FakeS3(), masterKey());
    const content = Buffer.from("fetch me back");
    const hash = computeHash(content);
    expect(await store.get(hash)).toBeNull();
    await store.put(hash, content);
    expect((await store.get(hash))?.equals(content)).toBe(true);
  });

  test("presentHashes returns the subset present (paginated bucket scan)", async () => {
    const s3 = new FakeS3();
    const store = new R2BlobStore(s3, masterKey());
    // Store 5 blobs (forces multiple list pages at page size 2).
    const stored = ["a", "b", "c", "d", "e"].map((s) => computeHash(Buffer.from(s)));
    for (const [i, hash] of stored.entries()) await store.put(hash, Buffer.from(["a", "b", "c", "d", "e"][i]));
    const absent = [computeHash(Buffer.from("x")), computeHash(Buffer.from("y"))];

    const present = await store.presentHashes([...stored, ...absent]);
    expect(present).toEqual(new Set(stored));
    expect(s3.existsCalls).toBe(0);
    expect(s3.listCalls).toBe(3);
  });

  test("presentHashes stops listing once every candidate is found", async () => {
    const s3 = new FakeS3();
    const store = new R2BlobStore(s3, masterKey());
    const stored = ["a", "b", "c", "d", "e"].map((s) => computeHash(Buffer.from(s)));
    for (const [i, hash] of stored.entries()) await store.put(hash, Buffer.from(["a", "b", "c", "d", "e"][i]));

    const present = await store.presentHashes(stored.slice(0, 3));
    expect(present).toEqual(new Set(stored.slice(0, 3)));
    expect(s3.existsCalls).toBe(0);
    expect(s3.listCalls).toBe(2);
  });

  test("presentHashes skips the bucket scan when there are no candidates", async () => {
    const s3 = new FakeS3();
    await s3.write("some-key", new Uint8Array([1])); // bucket is non-empty
    const store = new R2BlobStore(s3, masterKey());
    expect(await store.presentHashes([])).toEqual(new Set());
    expect(s3.existsCalls).toBe(0);
    expect(s3.listCalls).toBe(0);
  });
});

/** Counts uploads so dedup behavior is observable. */
class CountingRemote implements RemoteBlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  puts = 0;

  async put(hash: string, content: Uint8Array): Promise<void> {
    this.blobs.set(hash, Uint8Array.from(content));
    this.puts++;
  }
  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }
  async get(hash: string): Promise<Buffer | null> {
    const v = this.blobs.get(hash);
    return v ? Buffer.from(v) : null;
  }
  async presentHashes(hashes: Iterable<string>): Promise<Set<string>> {
    const present = new Set<string>();
    for (const h of hashes) if (this.blobs.has(h)) present.add(h);
    return present;
  }
}

describe("WriteThroughMediaStore", () => {
  const roots: string[] = [];
  const newRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "media-wt-"));
    roots.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("writes locally and uploads the encrypted blob", async () => {
    const local = new LocalMediaStore(newRoot());
    const remote = new CountingRemote();
    const store = new WriteThroughMediaStore(local, remote);
    const content = Buffer.from("hello");

    const result = await store.storeFile({ source: "discord", relativePath: "c/1/a.txt", content });

    expect(await store.readFile(result.storagePath)).not.toBeNull();
    expect(await remote.has(result.hash)).toBe(true);
    expect(remote.puts).toBe(1);
  });

  test("retries a transient upload failure through storeFile", async () => {
    const local = new LocalMediaStore(newRoot());
    const remote = new CountingRemote();
    const store = new WriteThroughMediaStore(local, remote, { retryBaseMs: 1 });
    const content = Buffer.from("retry me");
    let attempts = 0;
    remote.put = async (hash: string, bytes: Uint8Array) => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error("slow down"), { name: "S3Error", code: "SlowDown" });
      }
      remote.blobs.set(hash, Uint8Array.from(bytes));
      remote.puts++;
    };

    const result = await store.storeFile({ source: "facebook", relativePath: "c/1/a.jpg", content });

    expect(attempts).toBe(2);
    expect(remote.puts).toBe(1);
    expect(await remote.has(result.hash)).toBe(true);
  });

  test("does not re-upload a blob the remote already has", async () => {
    const local = new LocalMediaStore(newRoot());
    const remote = new CountingRemote();
    const store = new WriteThroughMediaStore(local, remote);
    const content = Buffer.from("dup");

    await store.storeFile({ source: "discord", relativePath: "c/1/a.txt", content });
    await store.storeFile({ source: "discord", relativePath: "c/2/b.txt", content });

    expect(remote.puts).toBe(1);
  });

  test("uploads a locally-cached blob the remote is missing (enable over a populated cache)", async () => {
    const root = newRoot();
    const content = Buffer.from("pre-existing");

    // Simulate a cache populated before R2 was enabled.
    await new LocalMediaStore(root).storeFile({ source: "discord", relativePath: "c/1/a.txt", content });

    const remote = new CountingRemote();
    const store = new WriteThroughMediaStore(new LocalMediaStore(root), remote);
    const result = await store.storeFile({ source: "discord", relativePath: "c/1/a.txt", content });

    expect(result.deduplicated).toBe(true);
    expect(remote.puts).toBe(1);
    expect(await remote.has(result.hash)).toBe(true);
  });

  test("restores a missing local file from the remote and repopulates the cache", async () => {
    const root = newRoot();
    const remote = new CountingRemote();
    const store = new WriteThroughMediaStore(new LocalMediaStore(root), remote);
    const content = Buffer.from("restore me");

    // Write through (local + remote), then lose the local cache entirely.
    const res = await store.storeFile({ source: "discord", relativePath: "c/1/a.txt", content });
    rmSync(root, { recursive: true, force: true });
    expect(await store.readFile(res.storagePath)).toBeNull();

    // Restore returns the decrypted bytes and refills the local cache.
    const restored = await store.restoreFromRemote(res.storagePath, res.hash);
    expect(restored).not.toBeNull();
    expect(Buffer.from(restored?.content as ArrayBuffer).equals(content)).toBe(true);
    expect(await store.readFile(res.storagePath)).not.toBeNull();
  });

  test("readUncached serves remote bytes without refilling the local cache", async () => {
    const root = newRoot();
    const store = new WriteThroughMediaStore(new LocalMediaStore(root), new CountingRemote());
    const content = Buffer.from("read me once");
    const res = await store.storeFile({ source: "discord", relativePath: "c/1/a.txt", content });
    expect((await store.readUncached(res.storagePath, res.hash))?.equals(content)).toBe(true);

    rmSync(root, { recursive: true, force: true });
    expect((await store.readUncached(res.storagePath, res.hash))?.equals(content)).toBe(true);
    expect(await store.readFile(res.storagePath)).toBeNull();
    expect(await store.readUncached(res.storagePath, computeHash(Buffer.from("absent")))).toBeNull();
  });

  test("returns null when the remote lacks the blob", async () => {
    const store = new WriteThroughMediaStore(new LocalMediaStore(newRoot()), new CountingRemote());
    const missing = computeHash(Buffer.from("absent"));
    expect(await store.restoreFromRemote("discord/c/1/a.txt", missing)).toBeNull();
  });

  test("a local-only store has nothing to restore from", async () => {
    const local = new LocalMediaStore(newRoot());
    expect(await local.restoreFromRemote("discord/c/1/a.txt", computeHash(Buffer.from("x")))).toBeNull();
  });

  test("readOrRestore serves locally without consulting the hash resolver", async () => {
    const store = new WriteThroughMediaStore(new LocalMediaStore(newRoot()), new CountingRemote());
    const res = await store.storeFile({ source: "discord", relativePath: "c/1/a.txt", content: Buffer.from("hi") });
    let resolverCalls = 0;
    const file = await readOrRestore(store, res.storagePath, () => {
      resolverCalls++;
      return res.hash;
    });
    expect(file).not.toBeNull();
    expect(resolverCalls).toBe(0);
  });

  test("readOrRestore restores from the remote on a local miss", async () => {
    const root = newRoot();
    const store = new WriteThroughMediaStore(new LocalMediaStore(root), new CountingRemote());
    const content = Buffer.from("restore via helper");
    const res = await store.storeFile({ source: "discord", relativePath: "c/1/a.txt", content });
    rmSync(root, { recursive: true, force: true });
    const file = await readOrRestore(store, res.storagePath, () => res.hash);
    expect(file !== null && Buffer.from(file.content).equals(content)).toBe(true);
  });

  test("readOrRestore returns null when the hash is unknown on a miss", async () => {
    const root = newRoot();
    const store = new WriteThroughMediaStore(new LocalMediaStore(root), new CountingRemote());
    const res = await store.storeFile({ source: "discord", relativePath: "c/1/a.txt", content: Buffer.from("x") });
    rmSync(root, { recursive: true, force: true });
    expect(await readOrRestore(store, res.storagePath, () => null)).toBeNull();
  });
});

describe("createR2BlobStore (fail-fast)", () => {
  const ENV_KEYS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "MEDIA_ENCRYPTION_KEY"] as const;
  const saved: Record<string, string | undefined> = {};
  const cfg = { enabled: true as const, account_id: "acc", bucket: "bucket" };

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.R2_ACCESS_KEY_ID = "test-access-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.MEDIA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("builds a store when fully configured", () => {
    expect(createR2BlobStore(cfg)).toBeInstanceOf(R2BlobStore);
  });
  test("throws without account_id", () => {
    expect(() => createR2BlobStore({ ...cfg, account_id: "" })).toThrow(/account_id/);
  });
  test("throws without bucket", () => {
    expect(() => createR2BlobStore({ ...cfg, bucket: "" })).toThrow(/bucket/);
  });
  test("throws without R2 credentials", () => {
    delete process.env.R2_ACCESS_KEY_ID;
    expect(() => createR2BlobStore(cfg)).toThrow(/R2_ACCESS_KEY_ID/);
  });
  test("throws without an encryption key", () => {
    delete process.env.MEDIA_ENCRYPTION_KEY;
    expect(() => createR2BlobStore(cfg)).toThrow(/MEDIA_ENCRYPTION_KEY/);
  });
});

describe("buildMediaStore (config selection)", () => {
  test("returns a plain local store when R2 is absent or disabled", async () => {
    expect(await buildMediaStore({ path: "/tmp/media" })).toBeInstanceOf(LocalMediaStore);
    expect(
      await buildMediaStore({ path: "/tmp/media", r2: { enabled: false, account_id: "a", bucket: "b" } }),
    ).toBeInstanceOf(LocalMediaStore);
  });

  test("returns a write-through store when R2 is enabled", async () => {
    const ENV_KEYS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "MEDIA_ENCRYPTION_KEY"] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.R2_ACCESS_KEY_ID = "test-access-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.MEDIA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    try {
      const store = await buildMediaStore({
        path: "/tmp/media",
        r2: { enabled: true, account_id: "acc", bucket: "bucket" },
      });
      expect(store).toBeInstanceOf(WriteThroughMediaStore);
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
