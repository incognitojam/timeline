import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { LocalMediaStore, WriteThroughMediaStore, type RemoteBlobStore } from "./storage";
import { cacheLimitBytes, evictMedia, planEviction, type LocalStat } from "./eviction";

// Stores bytes on put so `get` round-trips (read-through restore test); seed
// hashes mark presence-only entries for the durability checks.
class FakeRemote implements RemoteBlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  hasCalls = 0;
  presentHashesCalls = 0;
  constructor(seedHashes: string[] = []) {
    for (const h of seedHashes) this.blobs.set(h, new Uint8Array());
  }
  async put(hash: string, content: Uint8Array) {
    this.blobs.set(hash, Uint8Array.from(content));
  }
  async has(hash: string) {
    this.hasCalls++;
    return this.blobs.has(hash);
  }
  async get(hash: string) {
    const v = this.blobs.get(hash);
    return v ? Buffer.from(v) : null;
  }
  async presentHashes(hashes: Iterable<string>) {
    this.presentHashesCalls++;
    const r = new Set<string>();
    for (const h of hashes) if (this.blobs.has(h)) r.add(h);
    return r;
  }
}

function seedDb(): { db: Database; eventId: number } {
  const db = new Database(":memory:");
  initDb(db);
  const evt = db
    .query("INSERT INTO events (source, source_account, type, raw_data, conversation_id) VALUES ('discord', 'tester', 'message:dm', '{}', 'eviction-test-thread') RETURNING id")
    .get() as { id: number };
  return { db, eventId: evt.id };
}

describe("planEviction", () => {
  const roots: string[] = [];
  const newRoot = () => {
    const d = mkdtempSync(join(tmpdir(), "evict-"));
    roots.push(d);
    return d;
  };
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  // A: 100 bytes, oldest mtime · B: 200, middle · C: 300, newest.
  async function fixture() {
    const root = newRoot();
    const local = new LocalMediaStore(root);
    const make = async (name: string, size: number, mtimeMs: number) => {
      const res = await local.storeFile({
        source: "discord",
        relativePath: `a/${name}.png`,
        content: Buffer.alloc(size, name),
      });
      const path = join(root, "by-hash", res.hash.slice(0, 2), `${res.hash}.png`);
      utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
      return res;
    };
    const a = await make("A", 100, 1000);
    const b = await make("B", 200, 2000);
    const c = await make("C", 300, 3000);

    const { db, eventId } = seedDb();
    const att = db.prepare(
      "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, status) VALUES (?, 'discord', ?, ?, ?, 'stored')",
    );
    att.run(eventId, "A", a.hash, "discord/a/A.png");
    att.run(eventId, "B", b.hash, "discord/a/B.png");
    att.run(eventId, "C", c.hash, "discord/a/C.png");

    return { root, local, db, a, b, c };
  }

  test("measures local usage and the evictable (R2-durable) set", async () => {
    const { local, db, a, b, c } = await fixture();
    const plan = await planEviction(db, local, new FakeRemote([a.hash, b.hash, c.hash]), null);
    db.close();
    expect(plan.localBlobs).toBe(3);
    expect(plan.localBytes).toBe(600);
    expect(plan.evictableBlobs).toBe(3);
    expect(plan.evictableBytes).toBe(600);
    expect(plan.limitBytes).toBeNull();
    expect(plan.toEvictBlobs).toBe(0); // no bound → nothing planned
  });

  test("evicts oldest-mtime durable blobs down to the bound", async () => {
    const { local, db, a, b, c } = await fixture();
    const plan = await planEviction(db, local, new FakeRemote([a.hash, b.hash, c.hash]), 350);
    db.close();
    expect(plan.toEvictBlobs).toBe(2); // A(100, oldest) + B(200) reclaims 300 ≥ 250
    expect(plan.toEvictBytes).toBe(300);
    expect(plan.resultingBytes).toBe(300);
    expect(plan.shortfallBytes).toBe(0);
    // identities carried, oldest first, with the extension(s) the executor evicts
    expect(plan.selected.map((s) => s.hash)).toEqual([a.hash, b.hash]);
    expect(plan.selected[0].exts).toEqual([".png"]);
  });

  test("nothing to evict when under the bound", async () => {
    const { local, db, a, b, c } = await fixture();
    const plan = await planEviction(db, local, new FakeRemote([a.hash, b.hash, c.hash]), 1000);
    db.close();
    expect(plan.toEvictBlobs).toBe(0);
    expect(plan.resultingBytes).toBe(600);
  });

  test("excludes non-durable blobs and flags an unreachable bound", async () => {
    const { local, db, a } = await fixture();
    const plan = await planEviction(db, local, new FakeRemote([a.hash]), 100); // only A durable; need 500
    db.close();
    expect(plan.evictableBlobs).toBe(1);
    expect(plan.toEvictBlobs).toBe(1); // evicts A (100)
    expect(plan.toEvictBytes).toBe(100);
    expect(plan.shortfallBytes).toBe(400); // 500 needed − 100 evictable
  });

  test("plans no eviction without a remote durability source", async () => {
    const { local, db } = await fixture();
    const plan = await planEviction(db, local, null, 100);
    db.close();

    expect(plan.localBlobs).toBe(3);
    expect(plan.localBytes).toBe(600);
    expect(plan.evictableBlobs).toBe(0);
    expect(plan.evictableBytes).toBe(0);
    expect(plan.toEvictBlobs).toBe(0);
    expect(plan.resultingBytes).toBe(600);
    expect(plan.shortfallBytes).toBe(500);
  });

  test("keeps multiple local extension variants in one eviction target", async () => {
    const { db, eventId } = seedDb();
    const hash = "abc123";
    const att = db.prepare(
      "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, status) VALUES (?, 'discord', ?, ?, ?, 'stored')",
    );
    att.run(eventId, "png", hash, "discord/a/photo.png");
    att.run(eventId, "jpg", hash, "discord/a/photo.jpg");

    const stats = new Map([
      [`${hash}.png`, { size: 100, mtimeMs: 1000 }],
      [`${hash}.jpg`, { size: 100, mtimeMs: 5000 }],
    ]);
    const local: LocalStat = {
      async statByHash(h, ext) {
        return stats.get(`${h}${ext}`) ?? null;
      },
    };

    const plan = await planEviction(db, local, new FakeRemote([hash]), 0);
    db.close();

    expect(plan.localBlobs).toBe(1);
    expect(plan.localBytes).toBe(200);
    expect(plan.selected).toEqual([{ hash, exts: [".png", ".jpg"], diskBytes: 200 }]);
    expect(plan.toEvictBytes).toBe(200);
  });

  test("rejects an invalid bound (NaN/negative) rather than silently disabling", async () => {
    const { local, db, a } = await fixture();
    const remote = new FakeRemote([a.hash]);
    try {
      await expect(planEviction(db, local, remote, Number("abc"))).rejects.toThrow(/limitBytes/);
      await expect(planEviction(db, local, remote, -1)).rejects.toThrow(/limitBytes/);
    } finally {
      db.close();
    }
  });

  // --- executor ---

  test("removeBlob deletes every hardlink (by-hash + source) and frees disk", async () => {
    const { root, local, a } = await fixture();
    const source = join(root, "discord/a/A.png");
    expect(existsSync(source)).toBe(true);
    expect(await local.statByHash(a.hash, ".png")).not.toBeNull();

    await local.removeBlob(a.hash, [".png"], ["discord/a/A.png"]);

    expect(existsSync(source)).toBe(false); // source hardlink gone
    expect(await local.statByHash(a.hash, ".png")).toBeNull(); // by-hash gone → inode freed
  });

  test("a failed source unlink preserves the by-hash anchor (stays selectable)", async () => {
    const { root, local, a } = await fixture();
    // A directory at a "source path" can't be unlink()'d → forces a source failure
    // before the by-hash file is touched.
    mkdirSync(join(root, "discord/blocker"));
    await expect(local.removeBlob(a.hash, [".png"], ["discord/blocker"])).rejects.toThrow();
    // by-hash still present → planEviction can rediscover and retry this blob
    expect(await local.statByHash(a.hash, ".png")).not.toBeNull();
  });

  test("evictMedia dry run deletes nothing", async () => {
    const { root, local, db } = await fixture();
    const result = await evictMedia(db, local, new FakeRemote(), 0, { dryRun: true });
    db.close();
    expect(result.evicted).toBe(0);
    expect(existsSync(join(root, "discord/a/A.png"))).toBe(true);
  });

  test("evictMedia --execute removes the oldest durable blobs to the bound", async () => {
    const { root, local, db, a, b, c } = await fixture();
    const remote = new FakeRemote([a.hash, b.hash, c.hash]);
    const result = await evictMedia(db, local, remote, 350, {
      dryRun: false,
    });
    db.close();

    expect(result.evicted).toBe(2); // A + B (oldest), reclaiming 300 to reach 350
    expect(result.reclaimedBytes).toBe(300);
    expect(result.failed).toBe(0);
    // A and B gone (both links), C kept.
    expect(existsSync(join(root, "discord/a/A.png"))).toBe(false);
    expect(existsSync(join(root, "discord/a/B.png"))).toBe(false);
    expect(existsSync(join(root, "discord/a/C.png"))).toBe(true);
    expect(await local.statByHash(c.hash, ".png")).not.toBeNull();
    expect(result.durabilityCheck).toBe("targeted-head");
    expect(result.durabilityCheckedBlobs).toBe(2);
    expect(remote.hasCalls).toBe(2);
    expect(remote.presentHashesCalls).toBe(0);
  });

  test("evictMedia --execute falls back to full LIST after too many HEAD misses", async () => {
    const { root, local, db, a, b, c } = await fixture();
    const remote = new FakeRemote([c.hash]);
    const result = await evictMedia(db, local, remote, 350, {
      dryRun: false,
      targetedHeadCheckLimit: 1,
    });
    db.close();

    expect(result.durabilityCheck).toBe("full-list");
    expect(remote.hasCalls).toBe(1);
    expect(remote.presentHashesCalls).toBe(1);
    expect(result.evicted).toBe(1);
    expect(existsSync(join(root, "discord/a/A.png"))).toBe(true);
    expect(existsSync(join(root, "discord/a/B.png"))).toBe(true);
    expect(existsSync(join(root, "discord/a/C.png"))).toBe(false);
  });

  test("evictMedia dry run keeps the full LIST inventory for exact evictable totals", async () => {
    const { local, db, a, b, c } = await fixture();
    const remote = new FakeRemote([a.hash, b.hash, c.hash]);
    const result = await evictMedia(db, local, remote, 350, { dryRun: true });
    db.close();

    expect(result.durabilityCheck).toBe("full-list");
    expect(result.evictableBlobs).toBe(3);
    expect(remote.hasCalls).toBe(0);
    expect(remote.presentHashesCalls).toBe(1);
  });

  test("evictMedia removes source hardlinks across every media table", async () => {
    const root = newRoot();
    const local = new LocalMediaStore(root);
    const content = Buffer.from("shared across registry");
    const attachment = await local.storeFile({
      source: "discord",
      relativePath: "attachments/shared.png",
      content,
    });
    const emoji = await local.storeFile({
      source: "discord",
      relativePath: "emoji/999.png",
      content,
    });
    expect(emoji.hash).toBe(attachment.hash);

    const { db, eventId } = seedDb();
    db.prepare(
      "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, status) VALUES (?, 'discord', 'shared-att', ?, ?, 'stored')",
    ).run(eventId, attachment.hash, attachment.storagePath);
    db.prepare(
      "INSERT INTO discord_emojis (emoji_id, name, ext, content_hash, storage_path, file_size, status) VALUES ('999', 'shared', 'png', ?, ?, ?, 'stored')",
    ).run(attachment.hash, emoji.storagePath, content.length);

    const result = await evictMedia(db, local, new FakeRemote([attachment.hash]), 0, {
      dryRun: false,
    });
    db.close();

    expect(result.evicted).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(join(root, attachment.storagePath))).toBe(false);
    expect(existsSync(join(root, emoji.storagePath))).toBe(false);
    expect(await local.statByHash(attachment.hash, ".png")).toBeNull();
  });

  test("an evicted blob is restored from R2 by read-through", async () => {
    const { root, db } = await fixture();
    db.close();
    // Write a blob through to the cache + remote, then evict it locally.
    const remote = new FakeRemote();
    const store = new WriteThroughMediaStore(new LocalMediaStore(root), remote);
    const content = Buffer.from("evict then restore");
    const res = await store.storeFile({ source: "discord", relativePath: "c/1/x.png", content });

    await new LocalMediaStore(root).removeBlob(res.hash, [".png"], [res.storagePath]);
    expect(await store.readFile(res.storagePath)).toBeNull(); // evicted locally

    const restored = await store.restoreFromRemote(res.storagePath, res.hash);
    expect(restored && Buffer.from(restored.content).equals(content)).toBe(true);
    expect(await store.readFile(res.storagePath)).not.toBeNull(); // re-cached on read
  });

  test("evictMedia counts a deletion failure without aborting the rest", async () => {
    const { local, db, a, b, c } = await fixture();
    const failing = {
      statByHash: (h: string, ext: string) => local.statByHash(h, ext),
      removeBlob: async (hash: string, exts: string[], paths: string[]) => {
        if (hash === a.hash) throw new Error("locked");
        return local.removeBlob(hash, exts, paths);
      },
    };
    const result = await evictMedia(db, failing, new FakeRemote([a.hash, b.hash, c.hash]), 350, {
      dryRun: false,
    });
    db.close();
    expect(result.failed).toBe(1); // A's deletion threw
    expect(result.evicted).toBe(1); // B still evicted
  });
});

describe("cacheLimitBytes", () => {
  test("resolves and validates the configured bound", () => {
    expect(cacheLimitBytes({ path: "/m" })).toBeNull();
    expect(cacheLimitBytes({ path: "/m", cache_limit_gib: 25 })).toBe(25 * 1024 ** 3);
    expect(() => cacheLimitBytes({ path: "/m", cache_limit_gib: -1 })).toThrow(/non-negative/);
    expect(() => cacheLimitBytes({ path: "/m", cache_limit_gib: Number("x") })).toThrow();
  });
});
