import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { importFacebookData } from "./facebook";

interface EventRow {
  source_id: string;
  type: string;
  title: string | null;
  people: string | null;
}

async function writeMessageFile(
  convDir: string,
  num: number,
  data: unknown
): Promise<void> {
  await writeFile(join(convDir, `message_${num}.json`), JSON.stringify(data));
}

describe("importFacebookData — people column", () => {
  let db: Database;
  let importDir: string;
  let convDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    importDir = join(tmpdir(), `fb-fixture-${randomUUID()}`);
    convDir = join(
      importDir,
      "your_facebook_activity",
      "messages",
      "inbox",
      "testchat_abc123"
    );
    await mkdir(convDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(importDir, { recursive: true, force: true });
  });

  function getRows(): EventRow[] {
    return db
      .prepare(
        "SELECT source_id, type, title, people FROM events WHERE source = 'facebook' AND type LIKE 'message%' ORDER BY timestamp"
      )
      .all() as EventRow[];
  }

  it("keys messages on the conversation's first-message timestamp", async () => {
    await writeMessageFile(convDir, 1, {
      title: "Test Group",
      thread_path: "inbox/testchat_1234567890123456",
      participants: [{ name: "Alice" }],
      thread_type: "RegularGroup",
      messages: [{ sender_name: "Alice", timestamp_ms: 1700000001000, content: "hi" }],
    });

    await importFacebookData(db, importDir, "tester");

    const row = db
      .prepare("SELECT conversation_id, raw_data FROM events WHERE source = 'facebook'")
      .get() as { conversation_id: string | null; raw_data: string };
    expect(row.conversation_id).toBe("1700000001000");
    expect(JSON.parse(row.raw_data).conversation.thread_path).toBe(
      "inbox/testchat_1234567890123456"
    );
    expect(JSON.parse(row.raw_data).conversation.first_message_ts).toBe(1700000001000);
  });

  it("synthesizes thread_path from the folder when the JSON omits it", async () => {
    // convDir is "testchat_abc123" (old-format suffix, no numeric id), but
    // all fresh imports key on the conversation's oldest-message timestamp.
    await writeMessageFile(convDir, 1, {
      title: "Test Group",
      participants: [{ name: "Alice" }],
      thread_type: null,
      messages: [{ sender_name: "Alice", timestamp_ms: 1700000001000, content: "hi" }],
    });

    await importFacebookData(db, importDir, "tester");

    const row = db
      .prepare("SELECT conversation_id, raw_data FROM events WHERE source = 'facebook'")
      .get() as { conversation_id: string | null; raw_data: string };
    expect(row.conversation_id).toBe("1700000001000");
    expect(JSON.parse(row.raw_data).conversation.thread_path).toBe("inbox/testchat_abc123");
  });

  it("unifies old and new export-era folders that share an oldest message", async () => {
    const numericConvDir = join(
      importDir,
      "your_facebook_activity",
      "messages",
      "inbox",
      "testchat_1234567890123456"
    );
    await mkdir(numericConvDir, { recursive: true });

    await writeMessageFile(convDir, 1, {
      title: "Test Group",
      thread_path: "inbox/testchat_ab12cd",
      participants: [{ name: "Alice" }],
      messages: [
        { sender_name: "Alice", timestamp_ms: 1700000002000, content: "old era" },
        { sender_name: "Alice", timestamp_ms: 1700000001000, content: "first" },
      ],
    });
    await writeMessageFile(numericConvDir, 1, {
      title: "Renamed Test Group",
      thread_path: "inbox/testchat_1234567890123456",
      participants: [{ name: "Alice" }],
      messages: [
        { sender_name: "Alice", timestamp_ms: 1700000003000, content: "new era" },
        { sender_name: "Alice", timestamp_ms: 1700000001000, content: "first" },
      ],
    });

    await importFacebookData(db, importDir, "tester");

    const rows = db
      .prepare("SELECT conversation_id FROM events WHERE source = 'facebook' ORDER BY timestamp")
      .all() as { conversation_id: string | null }[];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.conversation_id)).toEqual([
      "1700000001000",
      "1700000001000",
      "1700000001000",
    ]);
  });

  it("reimport repopulates conversation_id on pre-capture rows via the upsert", async () => {
    // A row imported before thread_path capture: same source_id the import
    // below regenerates, NULL conversation_id, raw_data without thread_path.
    db.exec("DROP TRIGGER IF EXISTS events_conversation_id_bi"); // Simulates a pre-enforcement legacy row.
    db.prepare(
      `INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, import_batch)
       VALUES ('facebook', 'msg:1700000001000:1700000001000:0', 'tester', 'message', ?, 'Test Group', ?, 'old-batch')`
    ).run(
      new Date(1700000001000).toISOString(),
      JSON.stringify({ sender_name: "Alice", conversation: { title: "Test Group" } })
    );

    await writeMessageFile(convDir, 1, {
      title: "Test Group",
      thread_path: "inbox/testchat_1234567890123456",
      participants: [{ name: "Alice" }],
      thread_type: "RegularGroup",
      messages: [{ sender_name: "Alice", timestamp_ms: 1700000001000, content: "hi" }],
    });

    await importFacebookData(db, importDir, "tester");

    const rows = db
      .prepare("SELECT conversation_id FROM events WHERE source = 'facebook'")
      .all() as { conversation_id: string | null }[];
    expect(rows).toEqual([{ conversation_id: "1700000001000" }]);
  });

  it("includes all senders in people even when participants array is empty", async () => {
    // Mirrors a real export shape: data.participants is empty, but
    // messages have multiple distinct senders. Pre-fix, every message stored
    // people=[sender_only]; post-fix, every message stores all four senders.
    await writeMessageFile(convDir, 1, {
      title: "Test Group",
      participants: [],
      thread_type: null,
      messages: [
        { sender_name: "Alice", timestamp_ms: 1700000003000, content: "hi" },
        { sender_name: "Bob", timestamp_ms: 1700000002000, content: "hello" },
        { sender_name: "Carol", timestamp_ms: 1700000001000, content: "hey" },
      ],
    });
    await writeMessageFile(convDir, 2, {
      title: "Test Group",
      participants: [],
      thread_type: null,
      messages: [
        { sender_name: "Dave", timestamp_ms: 1690000002000, content: "older" },
        { sender_name: "Alice", timestamp_ms: 1690000001000, content: "older" },
      ],
    });

    await importFacebookData(db, importDir, "tester");

    const rows = getRows();
    expect(rows).toHaveLength(5);

    const expectedSet = new Set([
      "facebook:name:Alice",
      "facebook:name:Bob",
      "facebook:name:Carol",
      "facebook:name:Dave",
    ]);
    for (const row of rows) {
      const people = JSON.parse(row.people ?? "[]") as string[];
      expect(new Set(people)).toEqual(expectedSet);
      expect(people.length).toBe(4);
    }
  });

  it("places sender first in the people array", async () => {
    await writeMessageFile(convDir, 1, {
      title: "Test Group",
      participants: [
        { name: "Alice" },
        { name: "Bob" },
        { name: "Carol" },
      ],
      thread_type: null,
      messages: [
        { sender_name: "Bob", timestamp_ms: 1700000001000, content: "hi" },
      ],
    });

    await importFacebookData(db, importDir, "tester");

    const rows = getRows();
    expect(rows).toHaveLength(1);
    const people = JSON.parse(rows[0].people ?? "[]") as string[];
    expect(people[0]).toBe("facebook:name:Bob");
    expect(new Set(people)).toEqual(
      new Set([
        "facebook:name:Alice",
        "facebook:name:Bob",
        "facebook:name:Carol",
      ])
    );
  });

  it("links attachments to the correct event on re-import", async () => {
    // Regression for the lastInsertRowid bug: when re-importing, the parser
    // would attach a photo to the wrong event because ON CONFLICT DO UPDATE
    // does not advance lastInsertRowid. The fix uses RETURNING id instead.
    //
    // Scenario: messages stored newest-first in message_1.json. On re-import,
    // the newer text reply UPSERT-INSERTs first (advancing lastInsertRowid),
    // then the older photo UPSERT-UPDATEs (lastInsertRowid stays put). Photo
    // attachments would then attach to the reply event id.
    const messages = [
      // Newest first — text reply that has no media
      {
        sender_name: "Bob",
        timestamp_ms: 1700000002000,
        content: "no photos here",
      },
      // Older photo message
      {
        sender_name: "Alice",
        timestamp_ms: 1700000001000,
        content: null,
        photos: [{ uri: "messages/inbox/testchat_abc123/photos/cat.jpg" }],
      },
    ];
    await writeMessageFile(convDir, 1, {
      title: "Test Group",
      participants: [{ name: "Alice" }, { name: "Bob" }],
      thread_type: null,
      messages,
    });

    // First import — establishes the baseline rows.
    await importFacebookData(db, importDir, "tester");

    // Bump lastInsertRowid into a totally unrelated row so that, if the bug
    // returned, the misattribution would be glaringly obvious.
    db.exec(
      "INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, import_batch) VALUES ('test', 'sentinel', 'tester', 'noise', '2025-01-01T00:00:00Z', 't', 'c', '{}', 'b')"
    );

    // Re-import the same export: every row should hit ON CONFLICT DO UPDATE.
    await importFacebookData(db, importDir, "tester");

    const photoEvent = db
      .prepare(
        "SELECT id FROM events WHERE source = 'facebook' AND type = 'message:photo'"
      )
      .get() as { id: number };
    const replyEvent = db
      .prepare(
        "SELECT id FROM events WHERE source = 'facebook' AND type = 'message' AND content = 'no photos here'"
      )
      .get() as { id: number };

    const attachments = db
      .prepare("SELECT event_id, filename FROM attachments WHERE source = 'facebook'")
      .all() as { event_id: number; filename: string }[];

    expect(attachments).toHaveLength(1);
    expect(attachments[0].event_id).toBe(photoEvent.id);
    expect(attachments[0].event_id).not.toBe(replyEvent.id);
  });

  it("merges participants and senders without duplicates", async () => {
    // participants names overlap with senders; should not duplicate identifiers.
    await writeMessageFile(convDir, 1, {
      title: "Test Group",
      participants: [{ name: "Alice" }, { name: "Bob" }],
      thread_type: null,
      messages: [
        { sender_name: "Alice", timestamp_ms: 1700000002000, content: "hi" },
        { sender_name: "Carol", timestamp_ms: 1700000001000, content: "hey" },
      ],
    });

    await importFacebookData(db, importDir, "tester");

    const rows = getRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const people = JSON.parse(row.people ?? "[]") as string[];
      expect(people.length).toBe(3);
      expect(new Set(people)).toEqual(
        new Set([
          "facebook:name:Alice",
          "facebook:name:Bob",
          "facebook:name:Carol",
        ])
      );
    }
  });
});
