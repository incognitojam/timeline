import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initDb } from "../db/schema";
import { processAttachmentThumbhashes, THUMBHASH_QUEUE_SQL } from "./thumbhash";

describe("thumbhash work queue", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  test("uses the partial work-queue index without planner statistics", () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${THUMBHASH_QUEUE_SQL}`).all() as Array<{
      detail: string;
    }>;
    const details = plan.map((row) => row.detail).join("\n");

    expect(details).toContain("USING INDEX idx_attachments_needs_thumbhash");
    expect(details).not.toContain("USING INDEX idx_attachments_status");
  });

  test("processes no attachments when the limit is zero", async () => {
    const event = db
      .prepare(`
        INSERT INTO events (source, source_id, type, timestamp, raw_data)
        VALUES ('test', 'event-1', 'event', '2026-01-01T00:00:00Z', '{}')
      `)
      .run();
    db.prepare(`
      INSERT INTO attachments (event_id, source, source_id, mime_type, storage_path, status)
      VALUES (?, 'test', 'image-1', 'image/png', 'test/image.png', 'stored')
    `).run(event.lastInsertRowid);

    expect(await processAttachmentThumbhashes(db, { limit: 0 })).toEqual({
      processed: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
    });
  });

  test("rejects invalid concurrency and limits before processing", async () => {
    await expect(processAttachmentThumbhashes(db, { concurrency: 0 })).rejects.toThrow(/concurrency/);
    await expect(processAttachmentThumbhashes(db, { concurrency: Number("x") })).rejects.toThrow(
      /concurrency/,
    );
    await expect(processAttachmentThumbhashes(db, { limit: -1 })).rejects.toThrow(/limit/);
  });
});
