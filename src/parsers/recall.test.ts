import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { chmod, mkdir, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { importRecall } from "./recall";

interface EventRow {
  id: number;
  source_id: string;
  source_account: string;
  type: string;
  timestamp: string;
  title: string | null;
  content: string | null;
  raw_data: string;
}

interface AttachmentRow {
  event_id: number;
  source_id: string;
  content_hash: string;
  filename: string;
  mime_type: string;
  file_size: number;
  width: number | null;
  height: number | null;
  storage_path: string;
  status: string;
}

// Minimal valid WebP container (RIFF "WEBP" + 8-byte VP8L chunk).
// Not a real image, but enough bytes for storeFile to hash and write.
const FAKE_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x14, 0x00, 0x00, 0x00, // RIFF + size
  0x57, 0x45, 0x42, 0x50,                         // "WEBP"
  0x56, 0x50, 0x38, 0x4c, 0x08, 0x00, 0x00, 0x00, // VP8L chunk
  0x2f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

describe("importRecall", () => {
  let db: Database;
  let recallDir: string;
  let mediaDir: string;
  const HOST = "test-mac";
  const DATE = "2026-05-13";

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    recallDir = join(tmpdir(), `recall-inbox-${randomUUID()}`);
    mediaDir = join(tmpdir(), `recall-media-${randomUUID()}`);
    await mkdir(join(recallDir, HOST, DATE), { recursive: true });
    await mkdir(mediaDir, { recursive: true });

    // Point storeFile at our temp media dir
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
  });

  afterEach(async () => {
    db.close();
    delete process.env.TIMELINE_MEDIA_PATH;
    await rm(recallDir, { recursive: true, force: true });
    await rm(mediaDir, { recursive: true, force: true });
  });

  async function writeCapture(
    stamp: string,
    sidecar: Record<string, unknown>,
    bytes: Uint8Array = FAKE_WEBP_BYTES
  ) {
    const dir = join(recallDir, HOST, DATE);
    await writeFile(join(dir, `${stamp}.webp`), bytes);
    await writeFile(join(dir, `${stamp}.json`), JSON.stringify(sidecar));
  }

  function getEvent(stamp: string): EventRow | undefined {
    return db
      .prepare(
        "SELECT id, source_id, source_account, type, timestamp, title, content, raw_data FROM events WHERE source = 'recall' AND source_id = ?"
      )
      .get(`${HOST}:${DATE}:${stamp}`) as EventRow | undefined;
  }

  function getAttachment(eventId: number): AttachmentRow | undefined {
    return db
      .prepare(
        "SELECT event_id, source_id, content_hash, filename, mime_type, file_size, width, height, storage_path, status FROM attachments WHERE event_id = ?"
      )
      .get(eventId) as AttachmentRow | undefined;
  }

  it("imports a webp+json pair into events and attachments, then deletes the source", async () => {
    await writeCapture("103045", {
      captured_at: "2026-05-13T10:30:45Z",
      hostname: HOST,
      frontmost_app: "Code",
      ocr_text: "function add(a, b) { return a + b; }",
      ocr_line_count: 1,
      width: 2880,
      height: 1800,
    });

    const stats = await importRecall(db, recallDir);

    expect(stats).toMatchObject({ scanned: 1, imported: 1, failed: 0, skipped: 0 });

    const event = getEvent("103045");
    expect(event).toBeDefined();
    expect(event?.source_account).toBe(HOST);
    expect(event?.type).toBe("screen:capture");
    expect(event?.timestamp).toBe("2026-05-13T10:30:45Z");
    expect(event?.title).toBe("Code");
    expect(event?.content).toBe("function add(a, b) { return a + b; }");

    const raw = JSON.parse(event!.raw_data);
    expect(raw.frontmost_app).toBe("Code");
    expect(raw.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(raw.deduplicated).toBe(false);

    const att = getAttachment(event!.id);
    expect(att).toBeDefined();
    expect(att?.mime_type).toBe("image/webp");
    expect(att?.filename).toBe("103045.webp");
    expect(att?.width).toBe(2880);
    expect(att?.height).toBe(1800);
    expect(att?.status).toBe("stored");
    expect(att?.storage_path).toBe(join("recall", HOST, DATE, "103045.webp"));
    expect(att?.content_hash).toBe(raw.content_hash);

    // Source files should be gone, by-hash copy should remain
    const remaining = await readdir(join(recallDir, HOST, DATE));
    expect(remaining).toHaveLength(0);
    const byHashDir = join(mediaDir, "by-hash", raw.content_hash.slice(0, 2));
    const byHashFiles = await readdir(byHashDir);
    expect(byHashFiles).toContain(`${raw.content_hash}.webp`);
  });

  it("imports the flat date layout written by the local menu bar app", async () => {
    await mkdir(join(recallDir, DATE), { recursive: true });
    await writeFile(join(recallDir, DATE, "103100.webp"), FAKE_WEBP_BYTES);
    await writeFile(
      join(recallDir, DATE, "103100.json"),
      JSON.stringify({
        captured_at: "2026-05-13T10:31:00Z",
        hostname: HOST,
        app: "Code",
        ocr_text: "flat capture",
      })
    );

    const stats = await importRecall(db, recallDir);

    expect(stats).toMatchObject({ scanned: 1, imported: 1, failed: 0, skipped: 0 });
    expect(getEvent("103100")?.source_account).toBe(HOST);
    expect(await readdir(join(recallDir, DATE))).toHaveLength(0);
  });

  it("imports per-window captures, titled by app, sharing a tick timestamp", async () => {
    await writeCapture("143000-00", {
      schema_version: 1,
      captured_at: "2026-05-13T14:30:00Z",
      hostname: HOST,
      app: "Safari",
      bundle_id: "com.apple.Safari",
      window_title: "Start Page",
      is_frontmost: true,
      ocr_text: "today's headlines",
      width: 1600,
      height: 1200,
      window_id: 42,
      window_index: 0,
      frame: { x: 100, y: 50, w: 800, h: 600 },
      window_layer: 0,
      display_id: 1,
      display_frame: { x: 0, y: 0, w: 1512, h: 982 },
    });
    await writeCapture("143000-01", {
      captured_at: "2026-05-13T14:30:00Z",
      hostname: HOST,
      app: "Code",
      window_title: "main.swift",
      is_frontmost: false,
      ocr_text: "func capture()",
      width: 1400,
      height: 1000,
      window_id: 43,
      window_index: 1,
    });

    const stats = await importRecall(db, recallDir);
    expect(stats.imported).toBe(2);

    const safari = getEvent("143000-00");
    expect(safari?.title).toBe("Safari");
    const safariRaw = JSON.parse(safari!.raw_data);
    expect(safariRaw.window_title).toBe("Start Page");
    expect(safariRaw.bundle_id).toBe("com.apple.Safari");
    expect(safariRaw.is_frontmost).toBe(true);
    expect(safariRaw.window_id).toBe(42);
    // Spatial state preserved for future screen reconstruction.
    expect(safariRaw.schema_version).toBe(1);
    expect(safariRaw.frame).toEqual({ x: 100, y: 50, w: 800, h: 600 });
    expect(safariRaw.window_layer).toBe(0);
    expect(safariRaw.display_id).toBe(1);

    const code = getEvent("143000-01");
    expect(code?.title).toBe("Code");
    // Both windows captured in the same tick share a timestamp -> one session.
    expect(code?.timestamp).toBe(safari?.timestamp);
  });

  it("is FTS-searchable on OCR text", async () => {
    await writeCapture("121500", {
      captured_at: "2026-05-13T12:15:00Z",
      hostname: HOST,
      frontmost_app: "Safari",
      ocr_text: "Reviewing pull request feedback on the recall feature",
    });

    await importRecall(db, recallDir);

    const hit = db
      .prepare(
        "SELECT events.id FROM events JOIN events_fts ON events.id = events_fts.rowid WHERE events_fts MATCH 'recall'"
      )
      .get() as { id: number } | undefined;
    expect(hit).toBeDefined();
  });

  it("is idempotent: re-running picks up new files but does not duplicate prior events", async () => {
    await writeCapture("100000", {
      captured_at: "2026-05-13T10:00:00Z",
      hostname: HOST,
      frontmost_app: "Terminal",
      ocr_text: "first",
    });
    await importRecall(db, recallDir);

    await writeCapture("100030", {
      captured_at: "2026-05-13T10:00:30Z",
      hostname: HOST,
      frontmost_app: "Terminal",
      ocr_text: "second",
    });
    // Also write the SAME file again to simulate a re-pushed capture (rsync resurrecting it).
    await writeCapture("100000", {
      captured_at: "2026-05-13T10:00:00Z",
      hostname: HOST,
      frontmost_app: "Terminal",
      ocr_text: "first",
    });
    const stats = await importRecall(db, recallDir);

    expect(stats.imported).toBe(1);  // only 100030 is new
    expect(stats.skipped).toBe(1);   // 100000 was a duplicate

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'recall'")
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("limits a sync batch without removing unprocessed captures", async () => {
    await writeCapture("100000", {
      captured_at: "2026-05-13T10:00:00Z",
      hostname: HOST,
      frontmost_app: "Terminal",
    });
    await writeCapture("100030", {
      captured_at: "2026-05-13T10:00:30Z",
      hostname: HOST,
      frontmost_app: "Terminal",
    });

    const stats = await importRecall(db, recallDir, { maxCaptures: 1 });

    expect(stats).toMatchObject({ scanned: 1, imported: 1, failed: 0, skipped: 0 });
    const remaining = await readdir(join(recallDir, HOST, DATE));
    expect(remaining.filter((file) => file.endsWith(".webp"))).toHaveLength(1);
    expect(remaining.filter((file) => file.endsWith(".json"))).toHaveLength(1);
  });

  it("skips a webp without a sidecar json (interrupted upload)", async () => {
    const dir = join(recallDir, HOST, DATE);
    await writeFile(join(dir, "090000.webp"), FAKE_WEBP_BYTES);
    // no sidecar

    const stats = await importRecall(db, recallDir);

    expect(stats).toMatchObject({ scanned: 1, imported: 0, skipped: 1, failed: 0 });
    // Source file should remain so a later run with sidecar can retry
    const remaining = await readdir(dir);
    expect(remaining).toContain("090000.webp");
  });

  it("does not double-count when source-file cleanup fails after a successful import", async () => {
    // Regression: previously, an unlink failure was caught by the same
    // try/catch as the DB work, so the same entry was incremented in BOTH
    // stats.imported (success path) and stats.failed (outer catch).
    await writeCapture("140000", {
      captured_at: "2026-05-13T14:00:00Z",
      hostname: HOST,
      frontmost_app: "Code",
      ocr_text: "x",
    });

    // Drop write permission on the date dir so the unlink throws EACCES.
    const dateDir = join(recallDir, HOST, DATE);
    await chmod(dateDir, 0o555);

    try {
      const stats = await importRecall(db, recallDir);
      expect(stats.imported).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.scanned).toBe(stats.imported + stats.skipped + stats.failed);
    } finally {
      await chmod(dateDir, 0o755);
    }
  });

  it("deduplicates identical captures across hosts via content-addressed store", async () => {
    await writeCapture("110000", {
      captured_at: "2026-05-13T11:00:00Z",
      hostname: HOST,
      frontmost_app: "Code",
      ocr_text: "same screen",
    });

    // Second host, same image content
    const otherHost = "other-mac";
    await mkdir(join(recallDir, otherHost, DATE), { recursive: true });
    await writeFile(
      join(recallDir, otherHost, DATE, "110000.webp"),
      FAKE_WEBP_BYTES
    );
    await writeFile(
      join(recallDir, otherHost, DATE, "110000.json"),
      JSON.stringify({
        captured_at: "2026-05-13T11:00:00Z",
        hostname: otherHost,
        frontmost_app: "Code",
        ocr_text: "same screen",
      })
    );

    const stats = await importRecall(db, recallDir);
    expect(stats.imported).toBe(2);
    expect(stats.deduplicated).toBe(1);  // second store reused the by-hash copy
  });
});
