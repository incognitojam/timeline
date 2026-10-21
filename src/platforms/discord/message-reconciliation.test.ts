import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initDb } from "../../db/schema";
import type { NormalizedMessage } from "./client";
import { reconcileDiscordMessage } from "./message-reconciliation";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => db.close());

function message(content: string, editedAt: string | null): NormalizedMessage {
  return {
    id: "900000000000000000",
    type: "Default",
    rawType: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    timestampEdited: editedAt,
    content,
    flags: 0,
    author: {
      id: "author-1",
      name: "alice",
      nickname: "Alice",
      isBot: false,
      avatarUrl: null,
    },
    attachments: [],
    embeds: [],
    reactions: [],
    mentions: [],
  };
}

function insertStoredEvent(): void {
  const rawData = {
    id: "900000000000000000",
    type: 0,
    content: "before",
    flags: 0,
    author: { id: "author-1", username: "alice", global_name: "Alice" },
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: null,
    attachments: [],
    embeds: [],
    reactions: [{ emoji: { id: null, name: "👍" }, count: 1, users: [{ id: "u1", name: "Bob" }] }],
    poll: { question: { text: "Question" }, voters: { answers: [{ id: 1, voters: ["u1"] }] } },
    call: { participants: ["u1"], ended_timestamp: "2026-01-01T00:05:00.000Z" },
    _channel: { id: "channel-1", name: "general", guild_id: "guild-1", guild_name: "Example" },
  };
  db.prepare(
    `INSERT INTO events (
       source, source_id, source_account, type, timestamp, title, content,
       people, raw_data, conversation_id
     ) VALUES ('discord', ?, 'account-1', 'message:guild', ?, 'Example #general',
       'before', '["discord:author-1"]', ?, 'channel-1')`,
  ).run("900000000000000000", "2026-01-01T00:00:00.000Z", JSON.stringify(rawData));
}

describe("reconcileDiscordMessage", () => {
  test("stores the superseded snapshot and updates searchable content without losing enrichments", () => {
    insertStoredEvent();

    const result = reconcileDiscordMessage(
      db,
      message("after", "2026-01-01T00:01:00.000Z"),
      "account-1",
      "2026-01-01T00:02:00.000Z",
    );

    expect(result).toEqual({ found: true, edited: true, tombstoneCleared: false });
    const current = db.prepare(
      `SELECT content, raw_data FROM events WHERE source_id = '900000000000000000'`,
    ).get() as { content: string; raw_data: string };
    const raw = JSON.parse(current.raw_data);
    expect(current.content).toBe("after");
    expect(raw.reactions[0].users).toEqual([{ id: "u1", name: "Bob" }]);
    expect(raw.poll.voters).toEqual({ answers: [{ id: 1, voters: ["u1"] }] });
    expect(raw.call.ended_timestamp).toBe("2026-01-01T00:05:00.000Z");
    expect(raw._channel.name).toBe("general");

    const version = db.prepare(
      "SELECT observed_at, source_edited_at, raw_data FROM event_versions",
    ).get() as { observed_at: string; source_edited_at: string | null; raw_data: string };
    expect(version.observed_at).toBe("2026-01-01T00:02:00.000Z");
    expect(version.source_edited_at).toBeNull();
    expect(JSON.parse(version.raw_data).content).toBe("before");

    expect(db.prepare("SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH 'after'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM events_fts WHERE events_fts MATCH 'before'").get()).toEqual({ n: 0 });

    db.prepare("DELETE FROM events WHERE source_id = '900000000000000000'").run();
    expect(db.prepare("SELECT count(*) AS n FROM event_versions").get()).toEqual({ n: 0 });
  });

  test("does not version an embed-only refresh without an edit timestamp", () => {
    insertStoredEvent();
    const fresh = message("before", null);
    fresh.embeds = [{ type: "link", title: "unfurled later" }];

    const result = reconcileDiscordMessage(db, fresh, "account-1");

    expect(result.edited).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM event_versions").get()).toEqual({ n: 0 });
  });

  test("clears a tombstone when the message is observed again", () => {
    insertStoredEvent();
    db.prepare(
      "UPDATE events SET source_deleted_observed_at = '2026-01-02T00:00:00.000Z'",
    ).run();

    const result = reconcileDiscordMessage(db, message("before", null), "account-1");

    expect(result.tombstoneCleared).toBe(true);
    expect(db.prepare("SELECT source_deleted_observed_at FROM events").get()).toEqual({
      source_deleted_observed_at: null,
    });
  });
});
