import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import {
  BackupOffsiteStore,
  createBackupOffsiteStore,
  backupObjectKey,
  isBackupObjectKey,
  type BackupS3Like,
} from "./offsite-store";
import { computeHash } from "../media/storage";
import { decryptBlob } from "../media/crypto";

const masterKey = () => Buffer.from(randomBytes(32));

/** In-memory stand-in for the slice of Bun's S3 client BackupOffsiteStore uses. */
class FakeS3 implements BackupS3Like {
  readonly objects = new Map<string, Uint8Array>();

  async write(key: string, data: Uint8Array): Promise<number> {
    this.objects.set(key, Uint8Array.from(data));
    return data.length;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  // Prefix-filtered and paginated (page size 2) so the list continuation loop
  // and prefix scoping are both exercised.
  async list(options?: { prefix?: string; continuationToken?: string }) {
    const prefix = options?.prefix ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = options?.continuationToken ? Number(options.continuationToken) : 0;
    const slice = keys.slice(start, start + 2);
    const next = start + 2;
    const isTruncated = next < keys.length;
    return {
      contents: slice.map((key) => ({ key, size: this.objects.get(key)!.length })),
      isTruncated,
      nextContinuationToken: isTruncated ? String(next) : undefined,
    };
  }
}

function stage(dir: string, name: string, content: Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("object keys", () => {
  test("embeds the snapshot sha256 in a recognizable, self-describing key", () => {
    const hash = computeHash(Buffer.from("x"));
    const key = backupObjectKey("app-state", new Date("2026-06-26T11:24:16.000Z"), hash);
    expect(key).toBe(`app-state/2026-06-26T11-24-16__${hash}.db.enc`);
    // The writer's output is always recognized by the retention guard.
    expect(isBackupObjectKey(key)).toBe(true);
  });

  test("does not recognize foreign objects sharing the prefix", () => {
    expect(isBackupObjectKey("app-state/README")).toBe(false);
    expect(isBackupObjectKey("app-state/2026-06-26T11-24-16.db")).toBe(false);
    expect(isBackupObjectKey("app-state/2026-06-26T11-24-16__nothex.db.enc")).toBe(false);
  });
});

describe("BackupOffsiteStore", () => {
  const dirs: string[] = [];
  const newDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "offsite-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("uploads recoverable ciphertext, never the plaintext snapshot", async () => {
    const key = masterKey();
    const s3 = new FakeS3();
    const store = new BackupOffsiteStore(s3, key);
    const content = randomBytes(4096);
    const path = stage(newDir(), "snap.db", content);

    const up = await store.upload("app-state", path, new Date("2026-06-26T11:24:16.000Z"));
    expect(up.sha256).toBe(computeHash(content));
    expect(up.key).toBe(`app-state/2026-06-26T11-24-16__${up.sha256}.db.enc`);

    // R2 holds ciphertext, never the plaintext snapshot.
    const stored = s3.objects.get(up.key);
    expect(stored).toBeDefined();
    expect(Buffer.from(stored!).equals(content)).toBe(false);
    expect(up.size).toBe(stored!.length);

    expect(await store.list("app-state")).toEqual([up.key]);
    // The stored object decrypts back to the original using only the key's
    // embedded SHA-256 and the encryption key — i.e. restorable from the bucket
    // alone (restore tooling lands in a follow-up; this proves the format).
    expect(decryptBlob(key, up.sha256, Buffer.from(stored!)).equals(content)).toBe(true);
  });

  test("a tampered stored object fails to decrypt", async () => {
    const key = masterKey();
    const s3 = new FakeS3();
    const store = new BackupOffsiteStore(s3, key);
    const path = stage(newDir(), "snap.db", randomBytes(1024));
    const up = await store.upload("app-state", path);

    const stored = s3.objects.get(up.key)!;
    stored[stored.length - 1] ^= 0x01;
    expect(() => decryptBlob(key, up.sha256, Buffer.from(stored))).toThrow();
  });

  test("prune keeps the newest N snapshots and deletes the older ones", async () => {
    const s3 = new FakeS3();
    const store = new BackupOffsiteStore(s3, masterKey());
    const dir = newDir();

    // Five snapshots with strictly increasing timestamps (and distinct content).
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      const path = stage(dir, `s${i}.db`, randomBytes(256 + i));
      const up = await store.upload("app-state", path, new Date(Date.UTC(2026, 0, i + 1)));
      keys.push(up.key);
    }

    const deleted = await store.prune("app-state", 2);
    expect(deleted).toEqual(keys.slice(0, 3)); // oldest three removed
    expect(await store.list("app-state")).toEqual(keys.slice(3)); // newest two kept
  });

  test("prune deletes nothing when keepCount exceeds the snapshot count", async () => {
    const s3 = new FakeS3();
    const store = new BackupOffsiteStore(s3, masterKey());
    const dir = newDir();
    await store.upload("app-state", stage(dir, "a.db", randomBytes(64)), new Date(Date.UTC(2026, 0, 1)));
    await store.upload("app-state", stage(dir, "b.db", randomBytes(64)), new Date(Date.UTC(2026, 0, 2)));
    expect(await store.prune("app-state", 5)).toEqual([]);
  });

  test("list and prune are scoped to the prefix", async () => {
    const s3 = new FakeS3();
    const store = new BackupOffsiteStore(s3, masterKey());
    const dir = newDir();
    const appState = await store.upload("app-state", stage(dir, "a.db", randomBytes(64)));
    const timeline = await store.upload("timeline", stage(dir, "t.db", randomBytes(64)));

    expect(await store.list("app-state")).toEqual([appState.key]);
    // Pruning one prefix to zero leaves the other prefix's objects untouched.
    expect(await store.prune("app-state", 0)).toEqual([appState.key]);
    expect(await store.list("timeline")).toEqual([timeline.key]);
  });

  test("list and prune ignore foreign objects under the prefix", async () => {
    const s3 = new FakeS3();
    const store = new BackupOffsiteStore(s3, masterKey());
    const dir = newDir();
    // A non-snapshot object that merely shares the prefix (e.g. a marker file).
    await s3.write("app-state/README", new Uint8Array([1, 2, 3]));
    const older = await store.upload("app-state", stage(dir, "a.db", randomBytes(64)), new Date(Date.UTC(2026, 0, 1)));
    const newer = await store.upload("app-state", stage(dir, "b.db", randomBytes(64)), new Date(Date.UTC(2026, 0, 2)));

    // The foreign object is invisible to listing...
    expect(await store.list("app-state")).toEqual([older.key, newer.key]);
    // ...and retention only ever deletes real snapshots, never the marker.
    expect(await store.prune("app-state", 1)).toEqual([older.key]);
    expect(s3.objects.has("app-state/README")).toBe(true);
  });
});

describe("createBackupOffsiteStore (fail-fast)", () => {
  const ENV_KEYS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "BACKUP_ENCRYPTION_KEY"] as const;
  const saved: Record<string, string | undefined> = {};
  const cfg = { enabled: true as const, account_id: "acc", bucket: "timeline-backups" };

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.R2_ACCESS_KEY_ID = "test-access-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("builds a store when fully configured", () => {
    expect(createBackupOffsiteStore(cfg)).toBeInstanceOf(BackupOffsiteStore);
  });
  test("throws without account_id", () => {
    expect(() => createBackupOffsiteStore({ ...cfg, account_id: "" })).toThrow(/account_id/);
  });
  test("throws without bucket", () => {
    expect(() => createBackupOffsiteStore({ ...cfg, bucket: "" })).toThrow(/bucket/);
  });
  test("throws without R2 credentials", () => {
    delete process.env.R2_ACCESS_KEY_ID;
    expect(() => createBackupOffsiteStore(cfg)).toThrow(/R2_ACCESS_KEY_ID/);
  });
  test("throws without an encryption key", () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    expect(() => createBackupOffsiteStore(cfg)).toThrow(/BACKUP_ENCRYPTION_KEY/);
  });
});
