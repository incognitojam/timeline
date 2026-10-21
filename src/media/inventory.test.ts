import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { LocalMediaStore, computeHash, type RemoteBlobStore } from "./storage";
import { inventoryMedia } from "./inventory";

class FakeRemote implements RemoteBlobStore {
  constructor(private readonly present: Set<string>) {}
  async put(): Promise<void> {}
  async has(hash: string) {
    return this.present.has(hash);
  }
  async get() {
    return null;
  }
  async presentHashes(hashes: Iterable<string>) {
    const r = new Set<string>();
    for (const h of hashes) if (this.present.has(h)) r.add(h);
    return r;
  }
}

function seedDb(): { db: Database; eventId: number } {
  const db = new Database(":memory:");
  initDb(db);
  const evt = db
    .query("INSERT INTO events (source, source_account, type, raw_data, conversation_id) VALUES ('discord', 'tester', 'message:dm', '{}', 'inventory-test-thread') RETURNING id")
    .get() as { id: number };
  return { db, eventId: evt.id };
}

describe("inventoryMedia", () => {
  const roots: string[] = [];
  const newRoot = () => {
    const d = mkdtempSync(join(tmpdir(), "inv-"));
    roots.push(d);
    return d;
  };
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  test("classifies blobs by local × remote presence across media tables", async () => {
    const local = new LocalMediaStore(newRoot());
    // A: local + R2 · B: local only · C: missing · D: R2 only (durable, uncached)
    const a = await local.storeFile({ source: "discord", relativePath: "x/A.png", content: Buffer.from("blob-A") });
    const b = await local.storeFile({ source: "discord", relativePath: "x/B.png", content: Buffer.from("blob-B") });
    const cHash = computeHash(Buffer.from("blob-C"));
    const dHash = computeHash(Buffer.from("blob-D"));

    const { db, eventId } = seedDb();
    const att = db.prepare(
      "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, file_size, status) VALUES (?, 'discord', ?, ?, ?, ?, ?)",
    );
    att.run(eventId, "att-A", a.hash, a.storagePath, 100, "stored");
    att.run(eventId, "att-B", b.hash, b.storagePath, 200, "stored");
    att.run(eventId, "att-failed", null, null, null, "failed");
    const emoji = db.prepare(
      "INSERT INTO discord_emojis (emoji_id, name, ext, content_hash, storage_path, file_size, status) VALUES (?, 'e', 'png', ?, ?, ?, 'stored')",
    );
    emoji.run("111", cHash, "discord/emoji/C.png", 300);
    emoji.run("222", dHash, "discord/emoji/D.png", 400);

    const inv = await inventoryMedia(db, local, new FakeRemote(new Set([a.hash, dHash])));
    db.close();

    expect(inv.uniqueBlobs).toBe(4);
    expect(inv.r2Checked).toBe(true);
    expect(inv.durableInR2).toEqual({ blobs: 2, bytes: 500 }); // A(100) + D(400)
    expect(inv.localOnly).toEqual({ blobs: 1, bytes: 200 }); // B
    expect(inv.missing).toEqual({ blobs: 1, bytes: 300 }); // C
    expect(inv.failedRows).toBe(1);
  });

  test("reports local presence only when R2 is not configured", async () => {
    const local = new LocalMediaStore(newRoot());
    const a = await local.storeFile({ source: "discord", relativePath: "x/A.png", content: Buffer.from("only-A") });
    const gone = computeHash(Buffer.from("gone"));

    const { db, eventId } = seedDb();
    const att = db.prepare(
      "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, file_size, status) VALUES (?, 'discord', ?, ?, ?, ?, 'stored')",
    );
    att.run(eventId, "att-A", a.hash, a.storagePath, 10);
    att.run(eventId, "att-gone", gone, "discord/x/gone.png", 20);

    const inv = await inventoryMedia(db, local, null);
    db.close();

    expect(inv.r2Checked).toBe(false);
    expect(inv.durableInR2.blobs).toBe(0);
    expect(inv.localOnly).toEqual({ blobs: 1, bytes: 10 }); // present on disk
    expect(inv.missing).toEqual({ blobs: 1, bytes: 20 }); // absent on disk
  });

  test("treats a blob as local when present under any of its extensions", async () => {
    const local = new LocalMediaStore(newRoot());
    // Bytes stored locally as .jpg; the by-hash file is <hash>.jpg only.
    const content = Buffer.from("multi-ext blob");
    const stored = await local.storeFile({ source: "discord", relativePath: "x/photo.jpg", content });

    const { db, eventId } = seedDb();
    const att = db.prepare(
      "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, file_size, status) VALUES (?, 'discord', ?, ?, ?, ?, 'stored')",
    );
    // First-encountered row uses the absent .png variant; a later row uses .jpg.
    att.run(eventId, "att-png", stored.hash, "discord/x/photo.png", 50);
    att.run(eventId, "att-jpg", stored.hash, "discord/x/photo.jpg", 50);

    const inv = await inventoryMedia(db, local, null);
    db.close();

    expect(inv.uniqueBlobs).toBe(1);
    expect(inv.localOnly).toEqual({ blobs: 1, bytes: 50 }); // present via .jpg
    expect(inv.missing).toEqual({ blobs: 0, bytes: 0 });
  });
});
