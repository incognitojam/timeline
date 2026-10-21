import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../db/schema";
import { dedupeFacebookMessages, findDuplicateFacebookMessages } from "./dedupe-facebook-messages";

describe("dedupe-facebook-messages", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertMessage(opts: {
    sourceId: string;
    conversationId: string;
    sender: string;
    tsMs: number;
    content: string | null;
    type?: string;
    title?: string;
  }): number {
    const row = db
      .prepare(
        `INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, import_batch, conversation_id)
         VALUES ('facebook', ?, 'tester', ?, ?, ?, ?, ?, 'test-batch', ?) RETURNING id`
      )
      .get(
        opts.sourceId,
        opts.type ?? "message",
        new Date(opts.tsMs).toISOString(),
        opts.title ?? "Alice Example",
        opts.content,
        JSON.stringify({ sender_name: opts.sender, timestamp_ms: opts.tsMs, content: opts.content }),
        opts.conversationId
      ) as { id: number };
    return row.id;
  }

  it("deletes the twin in the smaller conversation, keeping the fuller one", () => {
    // Fuller era: three rows. Truncated era: twin of one message + one unique.
    insertMessage({ sourceId: "msg:100:100:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 100, content: "hello" });
    insertMessage({ sourceId: "msg:100:200:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 200, content: "shared" });
    insertMessage({ sourceId: "msg:100:300:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 300, content: "bye" });
    const twin = insertMessage({ sourceId: "msg:200:200:0", conversationId: "alice_ab12cd", sender: "Alice Example", tsMs: 200, content: "shared" });
    insertMessage({ sourceId: "msg:200:250:0", conversationId: "alice_ab12cd", sender: "Alice Example", tsMs: 250, content: "unique to old era" });

    const result = dedupeFacebookMessages(db, { silent: true });

    expect(result.deletedEvents).toBe(1);
    const remaining = db
      .prepare("SELECT id FROM events WHERE source='facebook' ORDER BY id")
      .all() as { id: number }[];
    expect(remaining.map((r) => r.id)).not.toContain(twin);
    expect(remaining).toHaveLength(4);
  });

  it("never deletes same-prefix rows sharing a timestamp (photo bursts)", () => {
    insertMessage({ sourceId: "msg:100:100:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 100, content: "[photo]", type: "message:photo" });
    insertMessage({ sourceId: "msg:100:100:1", conversationId: "1234567890123", sender: "Alice Example", tsMs: 100, content: "[photo]", type: "message:photo" });

    expect(findDuplicateFacebookMessages(db, "sender")).toHaveLength(0);
    expect(findDuplicateFacebookMessages(db, "title")).toHaveLength(0);
    const result = dedupeFacebookMessages(db, { silent: true });
    expect(result.deletedEvents).toBe(0);
  });

  it("deletes sender-drift twins via the title pass (account renames)", () => {
    // Same message in both eras, attributed to different sender names.
    insertMessage({ sourceId: "msg:100:100:0", conversationId: "1234567890123", sender: "Anthony Example", tsMs: 100, content: "hello" });
    insertMessage({ sourceId: "msg:100:200:0", conversationId: "1234567890123", sender: "Anthony Example", tsMs: 200, content: "more" });
    const twin = insertMessage({ sourceId: "msg:150:100:0", conversationId: "group_ab12cd", sender: "Callum Example", tsMs: 100, content: "hello" });

    expect(findDuplicateFacebookMessages(db, "sender")).toHaveLength(0);
    const result = dedupeFacebookMessages(db, { silent: true });

    expect(result.deletedEvents).toBe(1);
    const remaining = db
      .prepare("SELECT id FROM events WHERE source='facebook'")
      .all() as { id: number }[];
    expect(remaining.map((r) => r.id)).not.toContain(twin);
  });

  it("deletes same-conversation twins under different prefixes (dual-import artifacts)", () => {
    insertMessage({ sourceId: "msg:100:100:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 100, content: "hello" });
    const twin = insertMessage({ sourceId: "msg:150:100:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 100, content: "hello" });

    const result = dedupeFacebookMessages(db, { silent: true });

    expect(result.deletedEvents).toBe(1);
    const remaining = db
      .prepare("SELECT id FROM events WHERE source='facebook'")
      .all() as { id: number }[];
    expect(remaining.map((r) => r.id)).not.toContain(twin);
  });

  it("never matches rows that differ in both sender and title, or in content", () => {
    insertMessage({ sourceId: "msg:100:100:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 100, content: "hello", title: "Alice Example" });
    // Same ms + content but a different person's thread: not a twin.
    insertMessage({ sourceId: "msg:200:100:0", conversationId: "bob_ab12cd", sender: "Bob Example", tsMs: 100, content: "hello", title: "Bob Example" });
    // Same thread + sender + ms but different content: not a twin.
    insertMessage({ sourceId: "msg:200:100:1", conversationId: "alice_cd34ef", sender: "Alice Example", tsMs: 100, content: "different", title: "Alice Example" });

    expect(findDuplicateFacebookMessages(db, "sender")).toHaveLength(0);
    expect(findDuplicateFacebookMessages(db, "title")).toHaveLength(0);
    const result = dedupeFacebookMessages(db, { silent: true });
    expect(result.deletedEvents).toBe(0);
  });

  it("deletes attachment rows of deleted events and is idempotent", () => {
    insertMessage({ sourceId: "msg:100:100:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 100, content: "shared" });
    insertMessage({ sourceId: "msg:100:200:0", conversationId: "1234567890123", sender: "Alice Example", tsMs: 200, content: "x" });
    const twin = insertMessage({ sourceId: "msg:200:100:0", conversationId: "alice_ab12cd", sender: "Alice Example", tsMs: 100, content: "shared" });
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status) VALUES (?, 'facebook', 'pic.jpg', 'pic.jpg', 'pending')`
    ).run(twin);

    const first = dedupeFacebookMessages(db, { silent: true });
    expect(first.deletedEvents).toBe(1);
    expect(first.deletedAttachments).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n
    ).toBe(0);

    const second = dedupeFacebookMessages(db, { silent: true });
    expect(second.deletedEvents).toBe(0);
  });
});
