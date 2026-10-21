import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb, type TimelineEvent } from "../db/schema";
import { wrapDatabase } from "../db/pool";
import {
  addDiscordReplyTargets,
  resolveDiscordReplyTargets,
} from "./discord-reply-references";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => {
  db.close();
});

function insertOriginal(opts: {
  sourceId: string;
  sourceAccount: string;
  conversationId: string;
  type: string;
  content: string | null;
  timestamp: string;
  rawData: Record<string, unknown>;
}): number {
  const info = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, content,
      raw_data, conversation_id
    ) VALUES ('discord', ?, ?, ?, ?, 'Alice and Bob', ?, json(?), ?)
  `).run(
    opts.sourceId,
    opts.sourceAccount,
    opts.type,
    opts.timestamp,
    opts.content,
    JSON.stringify(opts.rawData),
    opts.conversationId,
  );
  return Number(info.lastInsertRowid);
}

/** Minimal reply event as returned by getConversation (raw_data is a string). */
function replyEvent(opts: {
  id: number;
  sourceAccount: string;
  rawData: Record<string, unknown>;
  type?: string;
}): TimelineEvent {
  return {
    id: opts.id,
    source: "discord",
    source_id: `reply-${opts.id}`,
    source_account: opts.sourceAccount,
    type: opts.type ?? "message:group",
    timestamp: "2026-01-02T00:00:00Z",
    end_timestamp: null,
    duration_ms: null,
    title: "Alice and Bob",
    content: "A reply",
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: JSON.stringify(opts.rawData),
    imported_at: "2026-01-02T00:00:00Z",
    import_batch: null,
    conversation_id: "9300000000000000001",
  } as unknown as TimelineEvent;
}

describe("resolveDiscordReplyTargets", () => {
  test("resolves a reply against the local events table", async () => {
    const originalId = insertOriginal({
      sourceId: "100",
      sourceAccount: "alice",
      conversationId: "9300000000000000001",
      type: "message:group",
      content: "Original text",
      timestamp: "2026-01-01T00:00:00Z",
      rawData: { author: { username: "bob", global_name: "Bob B" } },
    });

    const reply = replyEvent({
      id: 5001,
      sourceAccount: "alice",
      rawData: { message_reference: { type: 0, message_id: "100" } },
    });

    const targets = await resolveDiscordReplyTargets(wrapDatabase(db), [reply]);
    const target = targets.get(5001);
    expect(target).toBeDefined();
    expect(target?.eventId).toBe(originalId);
    expect(target?.conversationId).toBe("9300000000000000001");
    expect(target?.authorName).toBe("Bob B");
    expect(target?.content).toBe("Original text");
    expect(target?.hasAttachment).toBe(false);
  });

  test("flags an attachment-bearing replied-to message", async () => {
    insertOriginal({
      sourceId: "200",
      sourceAccount: "alice",
      conversationId: "9300000000000000001",
      type: "message:group:attachment",
      content: null,
      timestamp: "2026-01-01T00:00:00Z",
      rawData: {
        author: { username: "bob" },
        attachments: [{
          id: "att1",
          filename: "cat.png",
          size: 1234,
          url: "https://cdn.example.com/cat.png",
          content_type: "image/png",
        }],
      },
    });

    const reply = replyEvent({
      id: 5002,
      sourceAccount: "alice",
      rawData: { message_reference: { message_id: "200" } },
    });

    const targets = await resolveDiscordReplyTargets(wrapDatabase(db), [reply]);
    const target = targets.get(5002);
    expect(target?.hasAttachment).toBe(true);
    expect(target?.authorName).toBe("bob");
  });

  test("falls back to the embedded referenced_message when unresolved", async () => {
    const reply = replyEvent({
      id: 5003,
      sourceAccount: "alice",
      rawData: {
        message_reference: { type: 0, message_id: "999" },
        referenced_message: {
          id: "999",
          author: { username: "carol" },
          content: "Ghost message",
          timestamp: "2026-01-01T00:00:00Z",
        },
      },
    });

    const targets = await resolveDiscordReplyTargets(wrapDatabase(db), [reply]);
    const target = targets.get(5003);
    expect(target).toBeDefined();
    expect(target?.eventId).toBeNull();
    expect(target?.conversationId).toBeNull();
    expect(target?.authorName).toBe("carol");
    expect(target?.content).toBe("Ghost message");
  });

  test("reads attachment presence from an embedded snapshot's attachment_count", async () => {
    const reply = replyEvent({
      id: 5006,
      sourceAccount: "alice",
      rawData: {
        message_reference: { type: 0, message_id: "998" },
        referenced_message: {
          id: "998",
          author: { username: "carol" },
          content: "",
          attachment_count: 2,
        },
      },
    });

    const targets = await resolveDiscordReplyTargets(wrapDatabase(db), [reply]);
    const target = targets.get(5006);
    expect(target?.eventId).toBeNull();
    expect(target?.hasAttachment).toBe(true);
  });

  test("ignores flag-only forwards (`:forward` type with reply-shaped reference)", async () => {
    insertOriginal({
      sourceId: "500",
      sourceAccount: "alice",
      conversationId: "9300000000000000001",
      type: "message:group",
      content: "Snapshot original",
      timestamp: "2026-01-01T00:00:00Z",
      rawData: { author: { username: "bob" } },
    });

    // FLAG_HAS_SNAPSHOT forwards can carry message_reference.type 0/absent;
    // the converter's `:forward` type suffix is the verdict.
    const flagOnlyForward = replyEvent({
      id: 5007,
      sourceAccount: "alice",
      type: "message:group:forward",
      rawData: {
        flags: 1 << 14,
        message_reference: { type: 0, message_id: "500" },
      },
    });

    const targets = await resolveDiscordReplyTargets(wrapDatabase(db), [flagOnlyForward]);
    expect(targets.size).toBe(0);
  });

  test("ignores forwards (message_reference.type === 1)", async () => {
    insertOriginal({
      sourceId: "300",
      sourceAccount: "alice",
      conversationId: "9300000000000000001",
      type: "message:group",
      content: "Forwarded original",
      timestamp: "2026-01-01T00:00:00Z",
      rawData: { author: { username: "bob" } },
    });

    const forward = replyEvent({
      id: 5004,
      sourceAccount: "alice",
      rawData: { message_reference: { type: 1, message_id: "300" } },
    });

    const targets = await resolveDiscordReplyTargets(wrapDatabase(db), [forward]);
    expect(targets.size).toBe(0);
  });

  test("does not cross source_account boundaries", async () => {
    insertOriginal({
      sourceId: "400",
      sourceAccount: "bob",
      conversationId: "9300000000000000002",
      type: "message:group",
      content: "Bob's copy",
      timestamp: "2026-01-01T00:00:00Z",
      rawData: { author: { username: "bob" } },
    });

    const reply = replyEvent({
      id: 5005,
      sourceAccount: "alice",
      rawData: { message_reference: { type: 0, message_id: "400" } },
    });

    const targets = await resolveDiscordReplyTargets(wrapDatabase(db), [reply]);
    // No alice-scoped original and no embedded preview → no target.
    expect(targets.size).toBe(0);
  });
});

describe("addDiscordReplyTargets", () => {
  test("attaches replied_to and leaves other events untouched", () => {
    const reply = replyEvent({
      id: 6001,
      sourceAccount: "alice",
      rawData: { message_reference: { type: 0, message_id: "100" } },
    });
    const plain = replyEvent({ id: 6002, sourceAccount: "alice", rawData: {} });

    const targets = new Map([[6001, {
      eventId: 42,
      conversationId: "conv",
      authorId: "2000000000000000000",
      authorName: "Bob",
      content: "Hi",
      rawData: "{}",
      hasAttachment: true,
    }]]);

    const [withReply, withoutReply] = addDiscordReplyTargets([reply, plain], targets);
    expect(withReply.replied_to).toMatchObject({
      event_id: 42,
      conversation_id: "conv",
      author_name: "Bob",
      content: "Hi",
      has_attachment: true,
    });
    expect(withoutReply.replied_to).toBeUndefined();
  });
});
