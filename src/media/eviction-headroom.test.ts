import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../db/schema";
import { evictMedia, evictMediaIfNeeded, MEDIA_EVICTION_RECONCILE_MS, planEviction } from "./eviction";
import { LocalMediaStore, type RemoteBlobStore } from "./storage";

class Remote implements RemoteBlobStore {
  readonly present = new Set<string>();
  readonly confirmed = new Set<string>();
  headCalls = 0;
  listCalls = 0;
  async put(hash: string) { this.present.add(hash); }
  async get() { return null; }
  async has(hash: string) {
    this.headCalls++;
    if (this.present.has(hash)) this.confirmed.add(hash);
    return this.present.has(hash);
  }
  async presentHashes(hashes: Iterable<string>) {
    this.listCalls++;
    const found = new Set([...hashes].filter((hash) => this.present.has(hash)));
    for (const hash of found) this.confirmed.add(hash);
    return found;
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(sizes = Array<number>(10).fill(100)) {
  const root = mkdtempSync(join(tmpdir(), "eviction-headroom-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const db = new Database(":memory:");
  initDb(db);
  cleanup.push(async () => db.close());
  const event = db.query("INSERT INTO events (source,type,raw_data) VALUES ('discord','message:dm','{}') RETURNING id").get() as { id: number };
  const local = new LocalMediaStore(root);
  const remote = new Remote();
  const files = [];
  for (const [i, size] of sizes.entries()) {
    const stored = await local.storeFile({ source: "discord", relativePath: `${i}.png`, content: Buffer.alloc(size, i) });
    const path = local.getAbsolutePath(`by-hash/${stored.hash.slice(0, 2)}/${stored.hash}.png`);
    utimesSync(path, i + 1, i + 1);
    db.query("INSERT INTO attachments (event_id,source,source_id,content_hash,storage_path,status) VALUES (?,'discord',?,?,?,'stored')")
      .run(event.id, String(i), stored.hash, stored.storagePath);
    remote.present.add(stored.hash);
    files.push({ ...stored, path });
  }
  const removed: string[] = [];
  const unsafe: string[] = [];
  const remove = local.removeBlob.bind(local);
  spyOn(local, "removeBlob").mockImplementation(async (hash, exts, paths) => {
    // Record outside the executor's catch so a safety failure can't be swallowed.
    if (!remote.confirmed.has(hash) || !remote.present.has(hash)) unsafe.push(hash);
    removed.push(hash);
    await remove(hash, exts, paths);
  });
  return { db, local, remote, files, removed, unsafe };
}

describe("eviction headroom", () => {
  for (const [limit, count, remaining] of [[999, 2, 800], [500, 6, 400], [1000, 0, 1000], [1050, 0, 1000], [0, 10, 0]] as const) {
    test(`limit ${limit}: trigger unchanged, oldest ${count} blobs removed`, async () => {
      const f = await fixture();
      const result = await evictMedia(f.db, f.local, f.remote, limit, { dryRun: false });
      expect(result.targetBytes).toBe(Math.floor(limit * 0.9));
      expect(result.evicted).toBe(count);
      expect(result.resultingBytes).toBe(remaining);
      expect(result.shortfallBytes).toBe(0);
      expect(result.failed).toBe(0);
      expect(f.removed).toEqual(f.files.slice(0, count).map((f) => f.hash));
      expect(f.unsafe).toEqual([]);
      for (const [i, file] of f.files.entries()) {
        expect(existsSync(file.path)).toBe(i >= count);
        expect(existsSync(f.local.getAbsolutePath(file.storagePath))).toBe(i >= count);
      }
    });
  }

  test("a null limit reports only", async () => {
    const f = await fixture();
    const result = await evictMedia(f.db, f.local, f.remote, null, { dryRun: false });
    expect(result).toMatchObject({ targetBytes: null, evicted: 0, selected: [], resultingBytes: 1000, shortfallBytes: 0 });
    expect(f.removed).toEqual([]);
  });

  test("insufficient durable bytes reports the target shortfall, even after reaching the limit", async () => {
    const f = await fixture();
    for (const file of f.files.slice(5)) f.remote.present.delete(file.hash);
    const result = await evictMedia(f.db, f.local, f.remote, 500, { dryRun: false });
    expect(result).toMatchObject({ targetBytes: 450, resultingBytes: 500, shortfallBytes: 50, evicted: 5, failed: 0 });
    expect(f.unsafe).toEqual([]);
    for (const file of f.files.slice(5)) expect(existsSync(file.path)).toBe(true);
  });

  for (const headLimit of [128, 1, 0]) {
    test(`dry run and execution select the same durable oldest prefix (HEAD budget ${headLimit})`, async () => {
      const f = await fixture();
      // Equal mtimes exercise stable tie order; the oldest blob is not durable.
      for (const file of f.files.slice(0, 3)) utimesSync(file.path, 1, 1);
      f.remote.present.delete(f.files[0]!.hash);
      f.remote.present.delete(f.files[4]!.hash);
      const order = (await planEviction(f.db, f.local, f.remote, 0)).selected;
      for (const limit of [999, 850, 500, 100, 0]) {
        const plan = await planEviction(f.db, f.local, f.remote, limit);
        // Old policy's prefix ended when it reclaimed just the excess.
        let oldBytes = 0;
        let oldCount = 0;
        while (oldCount < order.length && oldBytes < 1000 - limit) oldBytes += order[oldCount++]!.diskBytes;
        expect(plan.selected).toEqual(order.slice(0, plan.selected.length));
        expect(plan.selected.slice(0, oldCount)).toEqual(order.slice(0, oldCount));
      }
      const dry = await evictMedia(f.db, f.local, f.remote, 850, { dryRun: true });
      expect(dry.selected.map((t) => t.hash)).toEqual([f.files[1]!.hash, f.files[2]!.hash, f.files[3]!.hash]);
      expect(dry.evicted).toBe(0);
      expect(f.removed).toEqual([]);
      for (const file of f.files) expect(existsSync(file.path)).toBe(true);
      f.remote.confirmed.clear();
      const executed = await evictMedia(f.db, f.local, f.remote, 850, { dryRun: false, targetedHeadCheckLimit: headLimit });
      expect(executed.selected).toEqual(dry.selected);
      expect(executed.resultingBytes).toBe(dry.resultingBytes);
      expect(executed.failed).toBe(0);
      expect(f.removed).toEqual(dry.selected.map((t) => t.hash));
      expect(f.unsafe).toEqual([]);
      expect(existsSync(f.files[0]!.path)).toBe(true);
      expect(existsSync(f.files[4]!.path)).toBe(true);
    });
  }

  test("the larger target falls back after 128 HEAD checks even when the old excess was covered", async () => {
    const f = await fixture([...Array<number>(129).fill(1), 10_000]);
    const result = await evictMedia(f.db, f.local, f.remote, 10_128, { dryRun: false });
    expect(result.targetBytes).toBe(9115);
    expect(result.durabilityCheck).toBe("full-list");
    expect(f.remote.headCalls).toBe(128);
    expect(f.remote.listCalls).toBe(1);
    expect(result.resultingBytes).toBe(0); // The last indivisible blob crosses the target.
    expect(f.removed).toEqual(f.files.map((f) => f.hash));
    expect(f.unsafe).toEqual([]);
    expect(result.failed).toBe(0);
  });

  test("after reclaiming headroom, ordinary runs skip and six-hour reconciliation does not evict again", async () => {
    const f = await fixture(Array<number>(10).fill(100_000));
    const before = Date.now();
    const first = await evictMediaIfNeeded(f.db, f.local, f.remote, 999_999, null);
    expect(first).toMatchObject({ evicted: 2, resultingBytes: 800_000, targetBytes: 899_999 });
    const stats = spyOn(f.local, "statByHash");
    const checks = f.remote.headCalls + f.remote.listCalls;
    expect(await evictMediaIfNeeded(f.db, f.local, f.remote, 999_999, before)).toHaveProperty("inventorySkipped", true);
    expect(stats).not.toHaveBeenCalled();
    expect(f.remote.headCalls + f.remote.listCalls).toBe(checks);
    expect(await evictMediaIfNeeded(f.db, f.local, f.remote, 999_999, before - MEDIA_EVICTION_RECONCILE_MS))
      .toMatchObject({ evicted: 0, resultingBytes: 800_000 });
    expect(f.removed).toEqual(f.files.slice(0, 2).map((f) => f.hash));
    expect(f.unsafe).toEqual([]);
  });
});
