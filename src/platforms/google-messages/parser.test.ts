import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initDb } from "../../db/schema";
import { conversationAddress, eventTypeFor, importGoogleMessages, parseRecord, type GmConversation, type GmMessage } from "./parser";

interface EventRow {
  source_id: string;
  type: string;
  timestamp: string;
  title: string;
  content: string;
  people: string;
  conversation_id: string | null;
  raw_data: string;
}

const ALICE = { participant_id: "2", number: "+447700900001", name: "Alice", is_me: false, visible: true };
const BOB = { participant_id: "3", number: "07700 900002", name: "Bob", is_me: false, visible: true };
const ME = { participant_id: "1", number: "+447700900000", is_me: true, visible: true };

function conversation(overrides: Partial<GmConversation> = {}): GmConversation {
  return { kind: "conversation", id: "10", folder: "INBOX", is_group: false, type: "SMS", participants: [ME, ALICE], ...overrides };
}

function message(overrides: Partial<GmMessage> = {}): GmMessage {
  return {
    kind: "message",
    id: "100",
    conversation_id: "10",
    timestamp_ms: Date.UTC(2026, 0, 2, 12, 0, 0, 123),
    direction: "incoming",
    message_type: "sms",
    sender_participant_id: "2",
    text: "hello",
    ...overrides,
  };
}

const done = (id = "10") => ({ kind: "conversation_done", id, messages: 1 });
const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r));

/** A 1×1 transparent PNG, so dimension probing has something real to decode. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

interface AttachmentRow {
  source_id: string;
  filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  storage_path: string | null;
  content_hash: string | null;
  status: string;
}

describe("google-messages parser", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  const rows = () =>
    db
      .prepare(
        "SELECT source_id, type, timestamp, title, content, people, conversation_id, raw_data FROM events WHERE source = 'google-messages' ORDER BY source_id",
      )
      .all() as EventRow[];

  const importAll = (lines: string[], onConversationDone?: (id: string) => void) =>
    importGoogleMessages(db, lines, { sourceAccount: "Owner", importBatch: "test", onConversationDone });

  it("imports sms/mms/rcs by transport with phone identities and a phone-style conversation key", async () => {
    const stats = await importAll(
      jsonl(
        conversation(),
        message({ id: "100", message_type: "sms", direction: "incoming" }),
        message({ id: "101", message_type: "mms", direction: "outgoing", timestamp_ms: Date.UTC(2026, 0, 2, 12, 1) }),
        message({ id: "102", message_type: "rcs", direction: "incoming", timestamp_ms: Date.UTC(2026, 0, 2, 12, 2) }),
        done(),
      ),
    );
    expect(stats).toEqual({
      imported: 3,
      skipped: 0,
      conversations: 1,
      conversationsDone: 1,
      conversationsFailed: [],
      identities: 2,
      unknownDirection: 0,
      systemSkipped: 0,
      attachmentsStored: 0,
      attachmentsThumbnails: 0,
      attachmentsFailed: 0,
      attachmentsUnavailable: 0,
    });

    const [sms, mms, rcs] = rows();
    expect(sms).toMatchObject({ source_id: "100", type: "sms:received", title: "Alice", content: "hello", conversation_id: "+447700900001" });
    // The owner identity is the phone's own number, so it links like any other phone identity.
    expect(JSON.parse(sms.people)).toEqual(["phone:+447700900001", "phone:+447700900000"]);
    expect(mms).toMatchObject({ type: "mms:sent" });
    expect(JSON.parse(mms.people)).toEqual(["phone:+447700900000", "phone:+447700900001"]);
    expect(rcs.type).toBe("rcs:received");
    expect(JSON.parse(rcs.raw_data)).toMatchObject({ message_type: "rcs", address: "+447700900001", conversation_type: "SMS", folder: "INBOX" });

    const identities = db.prepare("SELECT platform_id, display_name FROM identities WHERE platform = 'phone' ORDER BY platform_id").all();
    expect(identities).toEqual([
      { platform_id: "+447700900000", display_name: null },
      { platform_id: "+447700900001", display_name: "Alice" },
    ]);
  });

  it("falls back to the account label as owner when the phone reports no self number", async () => {
    await importAll(jsonl(conversation({ participants: [{ participant_id: "1", is_me: true, visible: true }, ALICE] }), message()));
    expect(JSON.parse(rows()[0].people)).toEqual(["phone:+447700900001", "phone:Owner"]);
  });

  it("keys group conversations on the sorted, normalized participant numbers", async () => {
    await importAll(
      jsonl(
        conversation({ id: "20", is_group: true, name: "Weekend plans", participants: [ME, BOB, ALICE] }),
        message({ id: "200", conversation_id: "20", sender_participant_id: "3", direction: "incoming" }),
        message({ id: "201", conversation_id: "20", direction: "outgoing", timestamp_ms: Date.UTC(2026, 0, 2, 12, 5) }),
      ),
    );
    const [incoming, outgoing] = rows();
    expect(incoming.conversation_id).toBe("+447700900001~+447700900002");
    expect(incoming.title).toBe("Weekend plans");
    expect(JSON.parse(incoming.people)[0]).toBe("phone:+447700900002");
    expect(JSON.parse(outgoing.people)).toEqual(["phone:+447700900000", "phone:+447700900002", "phone:+447700900001"]);
  });

  it("collapses duplicate and invisible identities of one counterparty into a single key", async () => {
    const stale = { participant_id: "5", number: "07700 900001", is_me: false, visible: false };
    const national = { participant_id: "6", number: "07700 900001", is_me: false, visible: true };
    const otherMe = { participant_id: "7", is_me: true, visible: true };
    await importAll(jsonl(conversation({ participants: [ME, otherMe, stale, national, ALICE] }), message()));
    const [row] = rows();
    expect(row.conversation_id).toBe("+447700900001");
    expect(row.title).toBe("Alice");
    expect(JSON.parse(row.raw_data).address).toBe("+447700900001");
  });

  it("resolves an incoming sender through the conversation participants when the message lacks a number", async () => {
    await importAll(jsonl(conversation(), message({ sender_participant_id: "2", sender_number: undefined })));
    expect(JSON.parse(rows()[0].people)[0]).toBe("phone:+447700900001");
  });

  it("reports completed and failed conversations so cursors can advance selectively", async () => {
    const completed: string[] = [];
    const stats = await importAll(
      jsonl(
        conversation({ id: "10" }),
        message({ id: "100", conversation_id: "10" }),
        done("10"),
        conversation({ id: "11" }),
        message({ id: "110", conversation_id: "11", timestamp_ms: Date.UTC(2026, 0, 3) }),
        { kind: "conversation_error", id: "11", error: "connection reset" },
      ),
      (id) => completed.push(id),
    );
    expect(completed).toEqual(["10"]);
    expect(stats).toMatchObject({ imported: 2, conversationsDone: 1, conversationsFailed: ["11"] });
  });

  it("skips messages already imported by a previous run and tolerates blank lines", async () => {
    const lines = jsonl(conversation(), message());
    await importAll(lines);
    const stats = await importAll([...lines, ""]);
    expect(stats).toMatchObject({ imported: 0, skipped: 1 });
    expect(rows()).toHaveLength(1);
  });

  it("skips tombstone banners instead of attributing them to the contact", async () => {
    const stats = await importAll(
      jsonl(
        conversation(),
        message({ id: "100", direction: "system", status: "TOMBSTONE_ONE_ON_ONE_SMS_CREATED", text: "Texting with Alice (SMS/MMS)" }),
        message({ id: "101", timestamp_ms: Date.UTC(2026, 0, 2, 12, 1) }),
      ),
    );
    expect(stats).toMatchObject({ imported: 1, systemSkipped: 1 });
    expect(rows().map((r) => r.source_id)).toEqual(["101"]);
  });

  it("counts messages with an unclassified direction and stores them as received", async () => {
    const stats = await importAll(jsonl(conversation(), message({ direction: "unknown", message_type: "type6" })));
    expect(stats.unknownDirection).toBe(1);
    expect(rows()[0].type).toBe("sms:received");
  });

  it("accepts an async line stream", async () => {
    async function* stream() {
      for (const line of jsonl(conversation(), message())) yield line;
    }
    const stats = await importGoogleMessages(db, stream(), { sourceAccount: "Owner", importBatch: "test" });
    expect(stats.imported).toBe(1);
  });

  it("fails loudly on malformed input", async () => {
    await expect(importAll(["{not json"])).rejects.toThrow(/Invalid Google Messages JSONL/);
    await expect(importAll(jsonl({ kind: "message", id: "1" }))).rejects.toThrow(/conversation_id/);
    await expect(importAll(jsonl(message()))).rejects.toThrow(/unknown conversation/);
    await expect(importAll(jsonl(done("99")))).rejects.toThrow(/unknown conversation/);
    await expect(importAll(jsonl({ ...conversation(), participants: ["+447700900001"] }))).rejects.toThrow(/malformed participant/);
    expect(() => parseRecord(JSON.stringify({ kind: "nope" }))).toThrow(/Unknown Google Messages record kind/);
  });

  describe("media", () => {
    let dir: string;
    let staging: string;
    let priorMediaPath: string | undefined;

    beforeEach(() => {
      dir = join(tmpdir(), `gmessages-parser-${randomUUID()}`);
      staging = join(dir, "staging");
      mkdirSync(join(dir, "media"), { recursive: true });
      mkdirSync(staging, { recursive: true });
      priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
      process.env.TIMELINE_MEDIA_PATH = join(dir, "media");
    });

    afterEach(() => {
      if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
      else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
      rmSync(dir, { recursive: true, force: true });
    });

    const attachments = () =>
      db
        .prepare(
          "SELECT a.source_id, a.filename, a.mime_type, a.file_size, a.width, a.height, a.storage_path, a.content_hash, a.status FROM attachments a JOIN events e ON e.id = a.event_id WHERE e.source = 'google-messages' ORDER BY a.source_id",
        )
        .all() as AttachmentRow[];

    const importWithMedia = (lines: string[]) =>
      importGoogleMessages(db, lines, { sourceAccount: "Owner", importBatch: "test", mediaDir: staging });

    const rawDataOf = (sourceId: string) => {
      const row = db.prepare("SELECT raw_data FROM events WHERE source = 'google-messages' AND source_id = ?").get(sourceId) as { raw_data: string } | null;
      if (!row) throw new Error(`no event ${sourceId}`);
      return JSON.parse(row.raw_data) as { media: Array<Record<string, unknown>> };
    };

    it("moves downloaded parts into media storage and records the ones the phone withheld", async () => {
      writeFileSync(join(staging, "abc_1-photo.png"), PNG_1X1);
      writeFileSync(join(staging, "abc_2-note.bin"), Buffer.from("not an image"));
      const mms = message({
        id: "300",
        message_type: "mms",
        text: "",
        media: [
          // The sidecar reports absolute paths; dimensions come from the file when the phone gives none.
          { media_id: "abc/1", name: "photo.png", mime_type: "image/png", size: 68, status: "stored", path: join(staging, "abc_1-photo.png") },
          // A relative path resolves against mediaDir; declared dimensions win over probing.
          { media_id: "abc/2", mime_type: "application/octet-stream", size: 12, width: 40, height: 30, status: "stored", path: "abc_2-note.bin" },
          { media_id: "abc/3", name: "secret.jpg", mime_type: "image/jpeg", size: 999, status: "unavailable" },
          { media_id: "abc/4", name: "gone.gif", mime_type: "image/gif", status: "failed" },
        ],
      });
      const stats = await importWithMedia(jsonl(conversation(), mms, done()));
      expect(stats).toMatchObject({ imported: 1, attachmentsStored: 2, attachmentsUnavailable: 1, attachmentsFailed: 1 });

      const rows = attachments();
      expect(rows.map((r) => [r.source_id, r.status])).toEqual([
        ["abc/1", "stored"],
        ["abc/2", "stored"],
        ["abc/3", "unrecoverable"],
        ["abc/4", "failed"],
      ]);
      expect(rows[0]).toMatchObject({ filename: "photo.png", mime_type: "image/png", file_size: PNG_1X1.length, width: 1, height: 1 });
      expect(rows[0].storage_path).toBe("google-messages/+447700900001/abc_1-photo.png");
      expect(rows[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(dir, "media", rows[0].storage_path ?? ""))).toBe(true);
      expect(rows[1]).toMatchObject({ filename: "abc_2", width: 40, height: 30, storage_path: "google-messages/+447700900001/abc_2-abc_2" });
      expect(rows[2]).toMatchObject({ filename: "secret.jpg", mime_type: "image/jpeg", file_size: 999, storage_path: null });

      // Staging files are consumed, and the transient path never reaches raw_data.
      expect(existsSync(join(staging, "abc_1-photo.png"))).toBe(false);
      expect(existsSync(join(staging, "abc_2-note.bin"))).toBe(false);
      const raw = rawDataOf("300");
      expect(raw.media).toHaveLength(4);
      expect(raw.media.every((m) => !("path" in m))).toBe(true);
    });

    it("attaches media to a message that was already imported without it", async () => {
      const mms = message({ id: "301", message_type: "mms", text: "see attached" });
      await importAll(jsonl(conversation(), mms, done()));
      expect(attachments()).toEqual([]);

      writeFileSync(join(staging, "p.png"), PNG_1X1);
      const withMedia = { ...mms, media: [{ media_id: "p", name: "p.png", mime_type: "image/png", status: "stored", path: join(staging, "p.png") }] };
      const stats = await importWithMedia(jsonl(conversation(), withMedia, done()));
      expect(stats).toMatchObject({ imported: 0, skipped: 1, attachmentsStored: 1 });
      expect(attachments().map((r) => [r.source_id, r.status])).toEqual([["p", "stored"]]);

      // Re-importing the same part again is idempotent.
      writeFileSync(join(staging, "p.png"), PNG_1X1);
      await importWithMedia(jsonl(conversation(), withMedia, done()));
      expect(attachments()).toHaveLength(1);
    });

    it("records a withheld part positionally, since the phone sends it with no media id", async () => {
      // A withheld part as the phone reports it: no decryption key means no media id either.
      const mms = message({
        id: "303",
        message_type: "rcs",
        text: "",
        media: [
          { media_id: "", name: "photo.png", mime_type: "image/png", size: 800000, width: 1600, height: 1200, status: "unavailable" },
          { media_id: "", mime_type: "image/png", size: 900000, status: "unavailable" },
        ],
      });
      const stats = await importWithMedia(jsonl(conversation(), mms, done()));
      expect(stats).toMatchObject({ attachmentsUnavailable: 2 });
      const rows = attachments();
      expect(rows.map((r) => [r.source_id, r.status, r.filename])).toEqual([
        ["part:0", "unrecoverable", "photo.png"],
        ["part:1", "unrecoverable", "part_1.png"],
      ]);

      // Re-importing the same message does not duplicate either part.
      await importWithMedia(jsonl(conversation(), mms, done()));
      expect(attachments()).toHaveLength(2);
    });

    it("stores the thumbnail copy, measured rather than trusting the declared size", async () => {
      writeFileSync(join(staging, "thumb.png"), PNG_1X1);
      const mms = message({
        id: "304",
        message_type: "rcs",
        text: "",
        media: [
          // The phone unlocked only the small copy; width/height still describe the original.
          { media_id: "", name: "shot.png", mime_type: "image/png", size: PNG_1X1.length, width: 1600, height: 1200, status: "thumbnail", path: "thumb.png" },
        ],
      });
      const stats = await importWithMedia(jsonl(conversation(), mms, done()));
      expect(stats).toMatchObject({ attachmentsStored: 0, attachmentsThumbnails: 1, attachmentsUnavailable: 0 });

      const rows = attachments();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source_id: "part:0", status: "stored", file_size: PNG_1X1.length, width: 1, height: 1 });
      expect(rows[0].storage_path).toBe("google-messages/+447700900001/part_0-shot.png");

      // The original's dimensions survive in raw_data, so the copy is identifiable as degraded.
      expect(rawDataOf("304").media[0]).toMatchObject({ status: "thumbnail", width: 1600, height: 1200 });
    });

    it("upgrades a withheld part in place once a copy can be fetched", async () => {
      const part = { media_id: "", name: "shot.png", mime_type: "image/png", size: 900000, width: 1600, height: 1200 };
      const withheld = message({ id: "305", message_type: "rcs", text: "", media: [{ ...part, status: "unavailable" }] });
      await importWithMedia(jsonl(conversation(), withheld, done()));
      expect(attachments().map((r) => [r.source_id, r.status])).toEqual([["part:0", "unrecoverable"]]);

      // Both statuses identify the part by position, so the second import rewrites
      // the same row rather than leaving a stale tombstone beside a new one.
      writeFileSync(join(staging, "thumb.png"), PNG_1X1);
      const recovered = { ...withheld, media: [{ ...part, status: "thumbnail" as const, path: "thumb.png" }] };
      await importWithMedia(jsonl(conversation(), recovered, done()));

      const rows = attachments();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source_id: "part:0", status: "stored", width: 1, height: 1 });
      expect(rows[0].storage_path).not.toBeNull();
    });

    it("fails loudly when stored media arrives without a media directory", async () => {
      const mms = message({ id: "302", message_type: "mms", media: [{ media_id: "x", status: "stored", path: "x.bin" }] });
      await expect(importAll(jsonl(conversation(), mms, done()))).rejects.toThrow(/no mediaDir/);
    });
  });

  it("falls back to the conversation id when no counterparty has a number", () => {
    expect(eventTypeFor(message({ message_type: "type6", direction: "unknown" }))).toBe("sms:received");
    expect(conversationAddress(conversation({ participants: [ME, { participant_id: "9", name: "Bot", is_me: false, visible: true }] }))).toBe("gm:10");
  });
});
