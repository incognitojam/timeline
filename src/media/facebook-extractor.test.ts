import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { computeHash } from "./storage";
import { extractFacebookMedia } from "./facebook-extractor";

// A real 7x5 PNG (same fixture as dimensions.test.ts) so Bun.Image can decode
// genuine width/height — the whole point of this end-to-end test.
const PNG_7x5 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAIAAAAG+GGPAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGM4IaeBiRhoJAoABQwk651Wm3kAAAAASUVORK5CYII=",
  "base64"
);

interface AttachmentRow {
  id: number;
  event_id: number;
  status: string;
  content_hash: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  storage_path: string | null;
  mime_type: string | null;
  filename: string | null;
}

describe("extractFacebookMedia", () => {
  let db: Database;
  let root: string;
  let stagingDir: string;
  let exportDir: string;
  let mediaDir: string;
  let priorMediaPath: string | undefined;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    root = join(tmpdir(), `fb-extractor-${randomUUID()}`);
    stagingDir = join(root, "staging");
    exportDir = join(root, "export");
    mediaDir = join(root, "media");
    await mkdir(stagingDir, { recursive: true });
    await mkdir(exportDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });

    // Point storeFile (via loadConfig) at our temp media dir.
    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(root, { recursive: true, force: true });
  });

  // Build a Facebook-export-style ZIP: stage each file at its in-archive path
  // under stagingDir, then zip the export root so the entry names match the
  // original_uri values the extractor feeds to `unzip -p`.
  async function buildExport(files: { uri: string; bytes: Uint8Array }[]): Promise<void> {
    for (const file of files) {
      const abs = join(stagingDir, file.uri);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.bytes);
    }
    const zipPath = join(exportDir, "messages.zip");
    const proc = Bun.spawn(["zip", "-q", "-r", "-X", zipPath, "your_facebook_activity"], {
      cwd: stagingDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`zip exited ${code}: ${await new Response(proc.stderr).text()}`);
    }
  }

  function seedEvent(): number {
    const res = db
      .prepare(
        `INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, import_batch, conversation_id)
         VALUES ('facebook', ?, 'tester', 'message:photo', '2026-01-01T00:00:00Z', 'photo', NULL, '{}', 'test', 'facebook-photo-thread')`
      )
      .run(randomUUID());
    return Number(res.lastInsertRowid);
  }

  function seedPendingAttachment(eventId: number, originalUri: string): number {
    const res = db
      .prepare(
        `INSERT INTO attachments (event_id, source, source_id, filename, mime_type, original_uri, status)
         VALUES (?, 'facebook', ?, ?, 'image/png', ?, 'pending')`
      )
      .run(eventId, originalUri, originalUri.split("/").pop() ?? null, originalUri);
    return Number(res.lastInsertRowid);
  }

  function getAttachment(id: number): AttachmentRow | undefined {
    return db
      .prepare(
        `SELECT id, event_id, status, content_hash, file_size, width, height, storage_path, mime_type, filename
         FROM attachments WHERE id = ?`
      )
      .get(id) as AttachmentRow | undefined;
  }

  it("extracts a pending image from the export ZIP, stores it, and decodes its dimensions", async () => {
    const uri = "your_facebook_activity/messages/inbox/conversation_abc123/photos/image.png";
    await buildExport([{ uri, bytes: PNG_7x5 }]);

    const eventId = seedEvent();
    const attachmentId = seedPendingAttachment(eventId, uri);

    const stats = await extractFacebookMedia(db, exportDir);

    expect(stats).toMatchObject({ processed: 1, stored: 1, deduplicated: 0, failed: 0, skipped: 0 });

    const att = getAttachment(attachmentId);
    expect(att).toBeDefined();
    expect(att?.status).toBe("stored");
    expect(att?.width).toBe(7);
    expect(att?.height).toBe(5);
    expect(att?.file_size).toBe(PNG_7x5.length);

    const expectedHash = computeHash(PNG_7x5);
    expect(att?.content_hash).toBe(expectedHash);
    expect(att?.storage_path).toBe(join("facebook", "conversation_abc123", "image.png"));

    // The bytes round-tripped through unzip into the content-addressed store,
    // and the stored file is byte-identical to the original.
    const byHash = join(mediaDir, "by-hash", expectedHash.slice(0, 2), `${expectedHash}.png`);
    expect(existsSync(byHash)).toBe(true);
    expect(readFileSync(join(mediaDir, att!.storage_path!))).toEqual(PNG_7x5);
  });

  it("stores an undecodable image with null dimensions instead of failing", async () => {
    // A .png whose bytes aren't a real image: Bun.Image.metadata() throws, the
    // extractor swallows it (dimensions are best-effort, columns are nullable),
    // and the attachment is still stored.
    const uri = "your_facebook_activity/messages/inbox/conversation_xyz789/photos/broken.png";
    const bogus = Buffer.from("not a real image - just text wearing a .png extension");
    await buildExport([{ uri, bytes: bogus }]);

    const eventId = seedEvent();
    const attachmentId = seedPendingAttachment(eventId, uri);

    const stats = await extractFacebookMedia(db, exportDir);

    expect(stats).toMatchObject({ processed: 1, stored: 1, failed: 0, skipped: 0 });

    const att = getAttachment(attachmentId);
    expect(att?.status).toBe("stored");
    expect(att?.width).toBeNull();
    expect(att?.height).toBeNull();
    expect(att?.content_hash).toBe(computeHash(bogus));
    expect(att?.file_size).toBe(bogus.length);
  });
});
