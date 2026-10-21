import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import {
  insertPendingAttachment,
  markAttachmentFailed,
  markAttachmentStored,
  storeAndInsertAttachment,
} from "./attachments";
import { computeHash } from "./storage";

interface AttachmentRow {
  id: number;
  event_id: number;
  source: string;
  source_id: string;
  content_hash: string | null;
  filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  storage_path: string | null;
  original_uri: string | null;
  status: string;
}

describe("attachment helpers", () => {
  let db: Database;
  let mediaDir: string;
  let priorMediaPath: string | undefined;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    mediaDir = join(tmpdir(), `timeline-attachments-${randomUUID()}`);
    await mkdir(mediaDir, { recursive: true });

    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(mediaDir, { recursive: true, force: true });
  });

  function seedEvent(source = "test"): number {
    const result = db
      .prepare(
        `INSERT INTO events (source, source_id, source_account, type, timestamp, raw_data, import_batch, conversation_id)
         VALUES (?, ?, 'tester', 'message', '2026-01-01T00:00:00Z', '{}', 'test', 'attachment-test-thread')`,
      )
      .run(source, randomUUID());
    return Number(result.lastInsertRowid);
  }

  function getAttachment(id: number): AttachmentRow | undefined {
    return db
      .prepare(
        `SELECT id, event_id, source, source_id, content_hash, filename,
                mime_type, file_size, width, height, storage_path,
                original_uri, status
         FROM attachments WHERE id = ?`,
      )
      .get(id) as AttachmentRow | undefined;
  }

  function getAttachmentFor(eventId: number, sourceId: string): AttachmentRow | undefined {
    return db
      .prepare(
        `SELECT id, event_id, source, source_id, content_hash, filename,
                mime_type, file_size, width, height, storage_path,
                original_uri, status
         FROM attachments WHERE event_id = ? AND source_id = ?`,
      )
      .get(eventId, sourceId) as AttachmentRow | undefined;
  }

  test("pending inserts preserve Facebook insert-or-ignore semantics", () => {
    const eventId = seedEvent("facebook");

    insertPendingAttachment(db, {
      eventId,
      source: "facebook",
      sourceId: "photo.png",
      filename: "photo.png",
      mimeType: "image/png",
      originalUri: "messages/inbox/a/photos/photo.png",
    });
    insertPendingAttachment(db, {
      eventId,
      source: "facebook",
      sourceId: "photo.png",
      filename: "replacement.png",
      mimeType: "image/webp",
      originalUri: "messages/inbox/a/photos/replacement.png",
    });

    const row = getAttachmentFor(eventId, "photo.png");
    expect(row).toBeDefined();
    expect(row?.filename).toBe("photo.png");
    expect(row?.mime_type).toBe("image/png");
    expect(row?.original_uri).toBe("messages/inbox/a/photos/photo.png");
    expect(row?.status).toBe("pending");
  });

  test("stored inserts go through content-addressed storage and upsert metadata", async () => {
    const eventId = seedEvent("discord");
    const content = Buffer.from("same attachment bytes");

    const first = await storeAndInsertAttachment(db, {
      eventId,
      source: "discord",
      sourceId: "123",
      filename: "first.txt",
      mimeType: "text/plain",
      width: 10,
      originalUri: "https://cdn.discordapp.com/old",
    }, content, "channel/123/first.txt");
    expect(first.deduplicated).toBe(false);

    const second = await storeAndInsertAttachment(db, {
      eventId,
      source: "discord",
      sourceId: "123",
      filename: "second.txt",
      mimeType: "text/plain",
      height: 20,
      originalUri: "https://cdn.discordapp.com/new",
    }, content, "channel/123/second.txt");
    expect(second.deduplicated).toBe(true);

    const row = getAttachmentFor(eventId, "123");
    expect(row).toBeDefined();
    expect(row?.content_hash).toBe(computeHash(content));
    expect(row?.filename).toBe("second.txt");
    expect(row?.file_size).toBe(content.length);
    expect(row?.width).toBeNull();
    expect(row?.height).toBe(20);
    expect(row?.storage_path).toBe(join("discord", "channel/123/second.txt"));
    expect(row?.original_uri).toBe("https://cdn.discordapp.com/new");
    expect(row?.status).toBe("stored");
  });

  test("failed inserts only flip status on existing rows", () => {
    const eventId = seedEvent("discord");

    insertPendingAttachment(db, {
      eventId,
      source: "discord",
      sourceId: "123",
      filename: "original.png",
      mimeType: "image/png",
      fileSize: 10,
    });
    markAttachmentFailed(db, {
      eventId,
      source: "discord",
      sourceId: "123",
      filename: "replacement.png",
      mimeType: "image/webp",
      fileSize: 99,
    });

    const row = getAttachmentFor(eventId, "123");
    expect(row).toBeDefined();
    expect(row?.filename).toBe("original.png");
    expect(row?.mime_type).toBe("image/png");
    expect(row?.file_size).toBe(10);
    expect(row?.status).toBe("failed");
  });

  test("stored recovery updates storage fields by attachment id", () => {
    const eventId = seedEvent("facebook");
    insertPendingAttachment(db, {
      eventId,
      source: "facebook",
      sourceId: "image.png",
      filename: "image.png",
      mimeType: "image/png",
    });

    const row = getAttachmentFor(eventId, "image.png");
    expect(row).toBeDefined();

    markAttachmentStored(db, row?.id ?? 0, {
      hash: "a".repeat(64),
      storagePath: "facebook/conversation/image.png",
      fileSize: 42,
    }, { width: 7, height: 5 });

    const updated = getAttachment(row?.id ?? 0);
    expect(updated?.content_hash).toBe("a".repeat(64));
    expect(updated?.storage_path).toBe("facebook/conversation/image.png");
    expect(updated?.file_size).toBe(42);
    expect(updated?.width).toBe(7);
    expect(updated?.height).toBe(5);
    expect(updated?.status).toBe("stored");
  });
});
