import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { existsSync, linkSync, mkdtempSync, truncateSync, unlinkSync, utimesSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../db/schema";
import { evictMedia, evictMediaIfNeeded, MEDIA_EVICTION_RECONCILE_MS, planEviction } from "./eviction";
import { LocalMediaStore, type RemoteBlobStore } from "./storage";

class Remote implements RemoteBlobStore {
  readonly hashes = new Set<string>();
  readonly checked = new Set<string>();
  async put(hash: string) { this.hashes.add(hash); }
  async has(hash: string) { this.checked.add(hash); return this.hashes.has(hash); }
  async get() { return null; }
  async presentHashes(hashes: Iterable<string>) {
    return new Set(await Promise.all([...hashes].map(async (hash) => await this.has(hash) ? hash : "")));
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cache-size-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const db = new Database(":memory:");
  initDb(db);
  cleanup.push(async () => db.close());
  const event = db.query("INSERT INTO events (source,type,raw_data) VALUES ('discord','message:dm','{}') RETURNING id").get() as { id: number };
  const local = new LocalMediaStore(root);
  const remote = new Remote();
  const add = async (name: string, size: number, durable = true, ext = ".png") => {
    const file = await local.storeFile({ source: "discord", relativePath: `${name}${ext}`, content: Buffer.alloc(size, name) });
    db.query("INSERT INTO attachments (event_id,source,source_id,content_hash,storage_path,status) VALUES (?,'discord',?,?,?,'stored')")
      .run(event.id, `${name}${ext}`, file.hash, file.storagePath);
    if (durable) await remote.put(file.hash);
    return { ...file, path: local.getAbsolutePath(`by-hash/${file.hash.slice(0, 2)}/${file.hash}${ext}`) };
  };
  const a = await add("a", 10_000);
  const b = await add("b", 20_000, false);
  const c = await add("c", 30_000);
  for (const [i, file] of [a, b, c].entries()) utimesSync(file.path, i + 1, i + 1);
  return { root, db, local, remote, add, a, b, c };
}

// Run the unchanged executable planner without deleting so the new path sees
// exactly the same cache, including mtimes and remote membership.
async function oldPlan(f: Awaited<ReturnType<typeof fixture>>, limit: number) {
  return evictMedia(f.db, {
    statByHash: f.local.statByHash.bind(f.local),
    removeBlob: async () => {},
  }, f.remote, limit, { dryRun: false });
}

describe("scheduled eviction size preflight", () => {
  test("under limit skips all DB inventory, blob stats, remote checks and deletes", async () => {
    const f = await fixture();
    const queries = spyOn(f.db, "query");
    const stats = spyOn(f.local, "statByHash");
    const deletes = spyOn(f.local, "removeBlob");
    const result = await evictMediaIfNeeded(f.db, f.local, f.remote, 1_000_000, Date.now());
    expect(result).toMatchObject({ inventorySkipped: true, limitBytes: 1_000_000 });
    expect(queries).not.toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();
    expect(deletes).not.toHaveBeenCalled();
    expect(f.remote.checked.size).toBe(0);
    expect(existsSync(f.a.path)).toBe(true);
  });

  for (const limit of [59_999, 35_000, 0]) {
    test(`over limit ${limit} executes exactly the old plan and keeps non-durable files`, async () => {
      const f = await fixture();
      const old = await oldPlan(f, limit);
      f.remote.checked.clear();
      const remove = f.local.removeBlob.bind(f.local);
      spyOn(f.local, "removeBlob").mockImplementation(async (hash, exts, paths) => {
        expect(f.remote.checked.has(hash)).toBe(true);
        expect(f.remote.hashes.has(hash)).toBe(true);
        await remove(hash, exts, paths);
      });
      const result = await evictMediaIfNeeded(f.db, f.local, f.remote, limit, Date.now());
      expect(result).toEqual(old);
      expect(existsSync(f.b.path)).toBe(true);
      for (const target of old.selected) {
        expect(await f.local.statByHash(target.hash, ".png")).toBeNull();
      }
    });
  }

  test("an overestimate from unregistered blobs invokes inventory but deletes nothing", async () => {
    const f = await fixture();
    await f.local.storeFile({ source: "discord", relativePath: "orphan.png", content: Buffer.alloc(1_000_000) });
    const upper = await f.local.cacheSizeEstimate();
    expect(upper).toBeGreaterThan(100_000);
    const old = await oldPlan(f, 100_000);
    expect(old.localBytes).toBe(60_000);
    const result = await evictMediaIfNeeded(f.db, f.local, f.remote, 100_000, Date.now());
    expect(result).toEqual(old);
    expect(old.selected).toEqual([]);
    expect(existsSync(f.a.path)).toBe(true);
  });

  test("a persistent underestimate cannot defer the old plan past reconciliation", async () => {
    const f = await fixture();
    // Models case-insensitive extension aliases: du sees one file while the
    // existing planner counts two spellings. This underestimate never heals.
    const probe = spyOn(f.local, "cacheSizeEstimate").mockResolvedValue(1);
    const recent = Date.now();
    expect(await evictMediaIfNeeded(f.db, f.local, f.remote, 59_999, recent))
      .toHaveProperty("inventorySkipped", true);
    const old = await oldPlan(f, 59_999);
    const reconciled = await evictMediaIfNeeded(f.db, f.local, f.remote, 59_999, recent - MEDIA_EVICTION_RECONCILE_MS);
    expect(reconciled).toEqual(old);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  for (const timestamp of [null, Number.NaN, Infinity, Date.now() + 86_400_000]) {
    test(`missing or invalid reconciliation timestamp ${timestamp} forces inventory`, async () => {
      const f = await fixture();
      const probe = spyOn(f.local, "cacheSizeEstimate").mockResolvedValue(1);
      const old = await oldPlan(f, 59_999);
      expect(await evictMediaIfNeeded(f.db, f.local, f.remote, 59_999, timestamp)).toEqual(old);
      expect(probe).not.toHaveBeenCalled();
    });
  }

  test("growth after the walk can defer eviction only until the next fresh run", async () => {
    const f = await fixture();
    const measure = f.local.cacheSizeEstimate.bind(f.local);
    const probe = spyOn(f.local, "cacheSizeEstimate").mockImplementationOnce(async () => {
      const before = await measure();
      await f.add("new", 200_000);
      return before;
    });
    const first = await evictMediaIfNeeded(f.db, f.local, f.remote, 100_000, Date.now());
    expect(first).toHaveProperty("inventorySkipped", true);
    const old = await oldPlan(f, 100_000);
    expect(old.localBytes).toBe(260_000);
    probe.mockRestore();
    const next = await evictMediaIfNeeded(f.db, f.local, f.remote, 100_000, Date.now());
    expect(next).toEqual(old);
    expect(old.selected.length).toBeGreaterThan(0);
  });

  test("source hardlinks are ignored; extension hardlinks are counted separately", async () => {
    const f = await fixture();
    const before = await f.local.cacheSizeEstimate();
    for (let i = 0; i < 10; i++) linkSync(f.a.path, join(f.root, `extra-${i}.png`));
    expect(await f.local.cacheSizeEstimate()).toBe(before);
    const jpg = await f.add("a", 10_000, true, ".jpg");
    unlinkSync(jpg.path);
    linkSync(f.a.path, jpg.path);
    const old = await oldPlan(f, 69_999);
    expect(old.localBytes).toBe(70_000);
    expect(await f.local.cacheSizeEstimate()).toBeGreaterThanOrEqual(old.localBytes);
    expect(await evictMediaIfNeeded(f.db, f.local, f.remote, 69_999, Date.now())).toEqual(old);
  });

  test("sparse and symlinked blobs cannot undercount the planner's logical sizes", async () => {
    const f = await fixture();
    truncateSync(f.a.path, 10_000_000);
    const target = join(f.root, "symlink-target");
    linkSync(f.c.path, target);
    unlinkSync(f.c.path);
    symlinkSync(target, f.c.path);
    const old = await oldPlan(f, 100_000);
    expect(await f.local.cacheSizeEstimate()).toBeGreaterThanOrEqual(old.localBytes);
    expect(await evictMediaIfNeeded(f.db, f.local, f.remote, 100_000, Date.now())).toEqual(old);
  });

  test("failed size walks fall back to inventory, including broken symlinks", async () => {
    const f = await fixture();
    symlinkSync(join(f.root, "missing"), join(f.root, "by-hash", "broken"));
    const estimate = await f.local.cacheSizeEstimate();
    // GNU du rejects dangling links; BSD du may count the link itself.
    expect(estimate === null || estimate >= 60_000).toBe(true);
    const old = await oldPlan(f, 59_999);
    expect(await evictMediaIfNeeded(f.db, f.local, f.remote, 59_999, Date.now())).toEqual(old);
  });

  test("files vanishing after the size check are excluded by the real inventory", async () => {
    const f = await fixture();
    const measure = f.local.cacheSizeEstimate.bind(f.local);
    spyOn(f.local, "cacheSizeEstimate").mockImplementationOnce(async () => {
      const bytes = await measure();
      await f.local.removeBlob(f.a.hash, [".png"], [f.a.storagePath]);
      return bytes;
    });
    const result = await evictMediaIfNeeded(f.db, f.local, f.remote, 59_999, Date.now());
    expect(result).toMatchObject({ localBytes: 50_000, selected: [], evicted: 0 });
    expect(existsSync(f.b.path)).toBe(true);
    expect(existsSync(f.c.path)).toBe(true);
  });

  test("dry-run retains the old full plan with genuinely evictable blobs and no deletes", async () => {
    const f = await fixture();
    const old = await planEviction(f.db, f.local, f.remote, 35_000);
    const probe = spyOn(f.local, "cacheSizeEstimate");
    const result = await evictMedia(f.db, f.local, f.remote, 35_000, { dryRun: true });
    expect(result).toEqual({ ...old, evicted: 0, reclaimedBytes: 0, failed: 0 });
    expect(result.selected.map((b) => b.hash)).toEqual([f.a.hash, f.c.hash]);
    expect(probe).not.toHaveBeenCalled();
    for (const file of [f.a, f.b, f.c]) {
      expect(existsSync(file.path)).toBe(true);
      expect(existsSync(f.local.getAbsolutePath(file.storagePath))).toBe(true);
    }
  });
});
