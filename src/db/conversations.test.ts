/**
 * Tests for renamed-conversation linking via `conversation_id`.
 *
 * The scenario: two events from the same Discord channel inserted under
 * different titles (channel was renamed between them). Without the linking
 * machinery they show as two separate conversations; with it they collapse
 * to one and either URL resolves the full history.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { initDb } from "./schema";
import { type QueryExecutor, wrapDatabase } from "./pool";
import {
  conversationTypeClause,
  listConversations,
  listConversationSources,
  getConversation,
  getConversationAround,
  getConversationMetadata,
  getConversationStats,
  exportConversationRange,
} from "./conversations";
import { upsertIdentity } from "./identities";
import { isConversationEventType } from "../shared/grouping";

let db: Database;

interface RecordedQuery {
  method: "query" | "get";
  sql: string;
  params: unknown[];
}

function setup(): void {
  db = new Database(":memory:");
  initDb(db);
}

function teardown(): void {
  db.close();
}

function allowLegacyNullConversationIds(): void {
  db.exec("DROP TRIGGER IF EXISTS events_conversation_id_bi"); // Simulates pre-enforcement legacy rows.
}

function createRecordingExecutor(database: Database): QueryExecutor & { queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    async query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      queries.push({ method: "query", sql, params });
      return database.prepare(sql).all(...(params as SQLQueryBindings[])) as T[];
    },
    async get<T>(sql: string, ...params: unknown[]): Promise<T | null> {
      queries.push({ method: "get", sql, params });
      return (database.prepare(sql).get(...(params as SQLQueryBindings[])) as T) ?? null;
    },
  };
}

function explainPlan(sql: string, params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as SQLQueryBindings[])) as { detail: string }[];
  return rows.map((row) => row.detail).join("\n");
}

function expectBoundedConversationIdLookup(plan: string): void {
  expect(plan).toContain("USING INDEX idx_events_conversation_id");
  expect(plan).toContain("source=? AND source_account=? AND conversation_id=?");
  expect(plan).not.toContain("USING INDEX idx_events_source");
  expect(plan).not.toContain("SCAN events");
  expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
}

function insertDiscordMessage(args: {
  sourceId: string;
  sourceAccount: string;
  title: string;
  conversationId: string | null;
  content: string;
  timestamp: string;
  type?: string;
  people?: string[];
  rawData?: Record<string, unknown>;
}): number {
  const result = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, content,
      people, raw_data, conversation_id
    ) VALUES ('discord', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    args.sourceId,
    args.sourceAccount,
    args.type ?? "message:guild",
    args.timestamp,
    args.title,
    args.content,
    args.people ? JSON.stringify(args.people) : null,
    JSON.stringify(args.rawData ?? {}),
    args.conversationId,
  );
  return Number(result.lastInsertRowid);
}

describe("conversation linking by conversation_id", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("conversationTypeClause matches shared conversation event type rules", () => {
    const cases = [
      "message:dm",
      "opencode:message:user",
      "sms:sent",
      "mms:received",
      "call:incoming",
      "comment",
      "group:comment",
      "github:issue_comment",
      "claude:memory",
      "reaction:like",
    ];

    const insert = db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, conversation_id)
      VALUES ('test', ?, 'tester', ?, '2026-01-01T00:00:00Z', 'Event type test', '{}', ?)
    `);
    for (const type of cases) {
      insert.run(`type-${type}`, type, isConversationEventType(type) ? `conversation-${type}` : null);
    }

    const rows = db.query<{ type: string }, []>(`
      SELECT type FROM events WHERE ${conversationTypeClause()} ORDER BY id
    `).all();

    expect(rows.map((row) => row.type)).toEqual(cases.filter(isConversationEventType));
  });

  test("renamed channel collapses to one conversation in listConversations", async () => {
    const channelId = "9100000000000000000";
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Example Guild Archived #example-project",
      conversationId: channelId,
      content: "old title message",
      timestamp: "2026-01-01T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Example Guild Archived #📍 example-project",
      conversationId: channelId,
      content: "new title message",
      timestamp: "2026-02-01T00:00:00Z",
    });

    const { conversations, total } = await listConversations(wrapDatabase(db));

    expect(total).toBe(1);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].conversationId).toBe(channelId);
    expect(conversations[0].messageCount).toBe(2);
    // The displayed title is the most recent one (after the rename).
    expect(conversations[0].title).toBe("Example Guild Archived #📍 example-project");
  });

  test("listConversationSources returns sources with conversation summaries", async () => {
    insertDiscordMessage({
      sourceId: "sources-discord-1",
      sourceAccount: "alice",
      title: "Discord source",
      conversationId: "9100000000000000001",
      content: "hello",
      timestamp: "2026-01-01T00:00:00Z",
    });
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
      VALUES ('facebook', 'sources-facebook-1', 'alice', 'message', '2026-01-01T00:00:00Z', 'Facebook source', 'hello', '{}', 'facebook-source-thread')
    `).run();
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data)
      VALUES ('spotify', 'sources-spotify-1', 'alice', 'listen:track', '2026-01-01T00:00:00Z', 'Not a conversation', 'track', '{}')
    `).run();

    const sources = await listConversationSources(wrapDatabase(db));

    expect(sources).toEqual(["discord", "facebook"]);
  });

  test("getConversationMetadata returns Discord server breadcrumb metadata", async () => {
    const channelId = "9100000000000000100";
    insertDiscordMessage({
      sourceId: "guild-meta-1",
      sourceAccount: "alice",
      title: "Test Server #general",
      conversationId: channelId,
      content: "hello",
      timestamp: "2026-01-01T00:00:00Z",
      rawData: {
        _channel: {
          id: channelId,
          name: "general",
          type: "GuildTextChat",
          guild_id: "9000000000000000100",
          guild_name: "Test Server",
        },
      },
    });

    const metadata = await getConversationMetadata(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
      sourceAccount: "alice",
    });

    expect(metadata.server).toEqual({
      source: "discord",
      id: "9000000000000000100",
      name: "Test Server",
    });

    // Without the request param the account resolves from the summary row —
    // the path the guild query must still filter on for its index seek.
    const metadataNoAccount = await getConversationMetadata(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
    });
    expect(metadataNoAccount.server?.id).toBe("9000000000000000100");
  });

  test("getConversationMetadata omits server metadata for Discord DMs", async () => {
    const channelId = "9100000000000000101";
    insertDiscordMessage({
      sourceId: "dm-meta-1",
      sourceAccount: "alice",
      type: "message:dm",
      title: "Bob",
      conversationId: channelId,
      content: "hello",
      timestamp: "2026-01-01T00:00:00Z",
      rawData: {
        _channel: {
          id: channelId,
          name: "Bob",
          type: "DirectMessage",
          guild_id: null,
          guild_name: null,
        },
      },
    });

    const metadata = await getConversationMetadata(wrapDatabase(db), {
      conversationId: "9200000000000000000",
      source: "discord",
      sourceAccount: "alice",
    });

    expect(metadata.server).toBeNull();
  });

  test("getConversation by conversation_id returns both pre- and post-rename messages", async () => {
    const channelId = "9100000000000000000";
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Example Guild Archived #example-project",
      conversationId: channelId,
      content: "old title message",
      timestamp: "2026-01-01T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Example Guild Archived #📍 example-project",
      conversationId: channelId,
      content: "new title message",
      timestamp: "2026-02-01T00:00:00Z",
    });

    const events = await getConversation(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
    });

    expect(events).toHaveLength(2);
    expect(events.map((e) => e.content).sort()).toEqual([
      "new title message",
      "old title message",
    ]);
  });

  test("getConversationAround spans the rename boundary", async () => {
    const channelId = "9100000000000000000";
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Example Guild Archived #example-project",
      conversationId: channelId,
      content: "before-rename-1",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const targetId = insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Example Guild Archived #example-project",
      conversationId: channelId,
      content: "before-rename-2",
      timestamp: "2026-01-15T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m3",
      sourceAccount: "alice",
      title: "Example Guild Archived #📍 example-project",
      conversationId: channelId,
      content: "after-rename-1",
      timestamp: "2026-02-01T00:00:00Z",
    });

    const result = await getConversationAround(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
      eventId: targetId,
    });

    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.content)).toEqual([
      "before-rename-1",
      "before-rename-2",
      "after-rename-1",
    ]);
  });

  test("conversation queries report captured version counts", async () => {
    const channelId = "9100000000000000000";
    const editedId = insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "General",
      conversationId: channelId,
      content: "edited twice",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const untouchedId = insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "General",
      conversationId: channelId,
      content: "never edited",
      timestamp: "2026-01-02T00:00:00Z",
    });
    const insertVersion = db.prepare(
      "INSERT INTO event_versions (event_id, observed_at, raw_data) VALUES (?, ?, '{}')",
    );
    insertVersion.run(editedId, "2026-01-03T00:00:00Z");
    insertVersion.run(editedId, "2026-01-04T00:00:00Z");

    const events = await getConversation(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
    });
    expect(events.map((e) => [e.id, e.version_count])).toEqual([
      [editedId, 2],
      [untouchedId, 0],
    ]);

    const around = await getConversationAround(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
      eventId: editedId,
    });
    expect(around.events.map((e) => [e.id, e.version_count])).toEqual([
      [editedId, 2],
      [untouchedId, 0],
    ]);
  });

  test("getConversationStats aggregates across both titles", async () => {
    const channelId = "9100000000000000000";
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Example Guild Archived #example-project",
      conversationId: channelId,
      content: "x",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:2000000000000000000"],
    });
    insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Example Guild Archived #📍 example-project",
      conversationId: channelId,
      content: "y",
      timestamp: "2026-02-01T00:00:00Z",
      people: ["discord:2000000000000000000"],
    });

    const stats = await getConversationStats(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
    });

    expect(stats.totalMessages).toBe(2);
    expect(stats.firstMessage).toBe("2026-01-01T00:00:00Z");
    expect(stats.lastMessage).toBe("2026-02-01T00:00:00Z");
  });

  test("getConversationStats fills zero-count months between active ones", async () => {
    const channelId = "9100000000000000000";
    // Nov 2025 and Feb 2026, skipping Dec/Jan across the year boundary.
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Gappy channel",
      conversationId: channelId,
      content: "x",
      timestamp: "2025-11-15T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Gappy channel",
      conversationId: channelId,
      content: "y",
      timestamp: "2026-02-15T00:00:00Z",
    });

    const stats = await getConversationStats(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
    });

    expect(stats.activityByMonth).toEqual([
      { month: "2025-11", count: 1 },
      { month: "2025-12", count: 0 },
      { month: "2026-01", count: 0 },
      { month: "2026-02", count: 1 },
    ]);
  });

  test("getConversationStats returns first/last event ids matching first/last message", async () => {
    const channelId = "9100000000000000000";
    // Insert newest-first so the ids don't trivially line up with timestamp order.
    const newest = insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Stable channel",
      conversationId: channelId,
      content: "y",
      timestamp: "2026-02-01T00:00:00Z",
    });
    const oldest = insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Stable channel",
      conversationId: channelId,
      content: "x",
      timestamp: "2026-01-01T00:00:00Z",
    });

    const stats = await getConversationStats(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
    });

    expect(stats.firstEventId).toBe(oldest);
    expect(stats.lastEventId).toBe(newest);
  });

  test("getConversationStats returns title history ordered by firstSeen", async () => {
    const channelId = "9100000000000000000";
    // Insert in non-chronological order to verify ORDER BY firstSeen.
    insertDiscordMessage({
      sourceId: "m3",
      sourceAccount: "alice",
      title: "🥀 Example Guild Archived #📰-news",
      conversationId: channelId,
      content: "newest",
      timestamp: "2026-03-01T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "❄ Example Guild Winter #📰-news",
      conversationId: channelId,
      content: "oldest",
      timestamp: "2026-01-01T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m1b",
      sourceAccount: "alice",
      title: "❄ Example Guild Winter #📰-news",
      conversationId: channelId,
      content: "oldest-2",
      timestamp: "2026-01-15T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "🌱 Example Guild Spring #📰-news",
      conversationId: channelId,
      content: "middle",
      timestamp: "2026-02-01T00:00:00Z",
    });

    const stats = await getConversationStats(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
    });

    expect(stats.titles).toHaveLength(3);
    expect(stats.titles.map((t) => t.title)).toEqual([
      "❄ Example Guild Winter #📰-news",
      "🌱 Example Guild Spring #📰-news",
      "🥀 Example Guild Archived #📰-news",
    ]);
    expect(stats.titles[0].firstSeen).toBe("2026-01-01T00:00:00Z");
    expect(stats.titles[0].lastSeen).toBe("2026-01-15T00:00:00Z");
    expect(stats.titles[0].messageCount).toBe(2);
    expect(stats.titles[2].firstSeen).toBe("2026-03-01T00:00:00Z");
  });

  test("getConversationStats returns single-entry title history for un-renamed conversations", async () => {
    const channelId = "9200000000000000000";
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Stable channel",
      conversationId: channelId,
      content: "x",
      timestamp: "2026-01-01T00:00:00Z",
    });

    const stats = await getConversationStats(wrapDatabase(db), {
      conversationId: channelId,
      source: "discord",
    });

    expect(stats.titles).toEqual([
      {
        title: "Stable channel",
        firstSeen: "2026-01-01T00:00:00Z",
        lastSeen: "2026-01-01T00:00:00Z",
        messageCount: 1,
      },
    ]);
  });

  test("getConversation resolves conversation_id threads through summaries and uses the conversation-id index", async () => {
    insertDiscordMessage({ sourceId: "d1", sourceAccount: "me", title: "general", conversationId: "chan-1", content: "one", timestamp: "2026-01-01T00:00:00Z" });
    insertDiscordMessage({ sourceId: "d2", sourceAccount: "me", title: "general", conversationId: "chan-1", content: "two", timestamp: "2026-01-02T00:00:00Z" });
    // Decoy: a different channel that happens to share the title — must not merge in.
    insertDiscordMessage({ sourceId: "d3", sourceAccount: "me", title: "general", conversationId: "chan-2", content: "other channel", timestamp: "2025-12-31T00:00:00Z" });
    const recording = createRecordingExecutor(db);

    const events = await getConversation(recording, {
      conversationId: "chan-1",
      source: "discord",
      sourceAccount: "me",
      limit: 100,
      order: "desc",
    });

    expect(events.map((event) => event.content)).toEqual(["two", "one"]);

    const eventQuery = recording.queries.find((query) =>
      query.sql.includes("FROM events e") && query.sql.includes("ORDER BY e.timestamp")
    );
    if (!eventQuery) throw new Error("Expected getConversation to query events");
    expectBoundedConversationIdLookup(explainPlan(eventQuery.sql, eventQuery.params));
  });

  test("keyless stale rows are absent from conversation summaries", async () => {
    allowLegacyNullConversationIds();
    // Facebook-style: no stable ID, multiple events under one title.
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, conversation_id)
      VALUES ('facebook', 'm1', 'alice', 'message:dm', '2026-01-01T00:00:00Z', 'Bob', '{}', NULL),
             ('facebook', 'm2', 'alice', 'message:dm', '2026-01-02T00:00:00Z', 'Bob', '{}', NULL),
             ('facebook', 'm3', 'alice', 'message:dm', '2026-01-03T00:00:00Z', 'Carol', '{}', NULL)
    `).run();

    const { conversations, total } = await listConversations(wrapDatabase(db));

    expect(total).toBe(0);
    expect(conversations).toEqual([]);
  });

  test("NULL and empty source accounts are rejected for new conversation events", () => {
    const channelId = "9100000000000000000";
    expect(() => insertDiscordMessage({
      sourceId: "null-account",
      sourceAccount: null as unknown as string,
      title: "General",
      conversationId: channelId,
      content: "null account message",
      timestamp: "2026-01-01T00:00:00Z",
    })).toThrow(/non-empty source_account/);
    expect(() => insertDiscordMessage({
      sourceId: "empty-account",
      sourceAccount: "",
      title: "General",
      conversationId: channelId,
      content: "empty account message",
      timestamp: "2026-01-02T00:00:00Z",
    })).toThrow(/non-empty source_account/);
  });

  test("conversation lists exclude keyless stale rows while showing id-keyed rows", async () => {
    allowLegacyNullConversationIds();
    const channelId = "9100000000000000000";
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "old title",
      conversationId: channelId,
      content: "x",
      timestamp: "2026-01-01T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "new title",
      conversationId: channelId,
      content: "y",
      timestamp: "2026-02-01T00:00:00Z",
    });
    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, conversation_id)
      VALUES ('facebook', 'fb1', 'alice', 'message:dm', '2026-01-15T00:00:00Z', 'Bob', '{}', NULL)
    `).run();

    const { conversations, total } = await listConversations(wrapDatabase(db));

    expect(total).toBe(1);
    const discord = conversations.find((c) => c.source === "discord");
    expect(discord?.title).toBe("new title");
    expect(discord?.messageCount).toBe(2);
    expect(conversations.some((c) => c.source === "facebook")).toBe(false);
  });

  test("listConversations search matches historical titles and returns full aggregate", async () => {
    const channelId = "9100000000000000000";
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Old project room",
      conversationId: channelId,
      content: "x",
      timestamp: "2026-01-01T00:00:00Z",
    });
    insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "New project room",
      conversationId: channelId,
      content: "y",
      timestamp: "2026-02-01T00:00:00Z",
    });

    const { conversations, total } = await listConversations(wrapDatabase(db), { search: "Old project" });

    expect(total).toBe(1);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].title).toBe("New project room");
    expect(conversations[0].messageCount).toBe(2);
  });

  test("conversation summaries update after inserts, updates, and deletes", async () => {
    const channelId = "9100000000000000000";
    insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "General",
      conversationId: channelId,
      content: "x",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const latestId = insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "General renamed",
      conversationId: channelId,
      content: "y",
      timestamp: "2026-02-01T00:00:00Z",
    });

    db.prepare("UPDATE events SET timestamp = ?, title = ? WHERE id = ?").run(
      "2025-12-01T00:00:00Z",
      "Older renamed",
      latestId,
    );
    let result = await listConversations(wrapDatabase(db));
    expect(result.conversations[0].title).toBe("General");
    expect(result.conversations[0].lastMessage).toBe("2026-01-01T00:00:00Z");

    db.prepare("DELETE FROM events WHERE source_id = 'm1'").run();
    result = await listConversations(wrapDatabase(db));
    expect(result.total).toBe(1);
    expect(result.conversations[0].title).toBe("Older renamed");
    expect(result.conversations[0].messageCount).toBe(1);

    db.prepare("DELETE FROM events WHERE source_id = 'm2'").run();
    result = await listConversations(wrapDatabase(db));
    expect(result.total).toBe(0);
  });

  test("initDb backfills conversation summaries for existing events", async () => {
    const existing = new Database(":memory:");
    existing.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_id TEXT,
        source_account TEXT,
        type TEXT NOT NULL,
        timestamp TEXT,
        end_timestamp TEXT,
        duration_ms INTEGER,
        title TEXT,
        content TEXT,
        latitude REAL,
        longitude REAL,
        location_name TEXT,
        people JSON,
        tags JSON,
        raw_data JSON NOT NULL,
        imported_at TEXT NOT NULL DEFAULT (datetime('now')),
        import_batch TEXT,
        conversation_id TEXT,
        UNIQUE(source, source_id, source_account)
      )
    `);
    existing.prepare(`
      INSERT INTO events (source, source_id, type, timestamp, title, raw_data, conversation_id)
      VALUES ('discord', 'm1', 'message:guild', '2026-01-01T00:00:00Z', 'Before', '{}', '9100000000000000000'),
             ('discord', 'm2', 'message:guild', '2026-02-01T00:00:00Z', 'After', '{}', '9100000000000000000')
    `).run();

    initDb(existing);
    const { conversations, total } = await listConversations(wrapDatabase(existing));

    expect(total).toBe(1);
    expect(conversations[0].title).toBe("After");
    expect(conversations[0].messageCount).toBe(2);
    existing.close();
  });

  test("exportConversationRange fetches endpoint and middle events inclusively", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice" });
    upsertIdentity(db, { platform: "discord", platformId: "2000000000000000000", displayName: "Bob" });
    const firstId = insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "first",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
    });
    insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "middle",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:1000000000000000000"],
    });
    const lastId = insertDiscordMessage({
      sourceId: "m3",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "last",
      timestamp: "2026-01-01T00:02:00Z",
      people: ["discord:2000000000000000000"],
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
    });

    expect(result.eventCount).toBe(3);
    expect(result.range.startEventId).toBe(firstId);
    expect(result.range.endEventId).toBe(lastId);
    expect(result.text).toContain("first");
    expect(result.text).toContain("middle");
    expect(result.text).toContain("last");
    expect(result.text).toContain("### 2026-01-01");
    expect(result.text).toContain("00:00 <Alice> first");
    expect(result.text).toContain("00:01 middle");
    expect(result.text).toContain("00:02 <Bob> last");
    expect(result.text).not.toContain("discord:1000000000000000000");
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  test("exportConversationRange applies format options", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice" });
    const firstId = insertDiscordMessage({
      sourceId: "format-1",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "first",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
    });
    const lastId = insertDiscordMessage({
      sourceId: "format-2",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "last",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:1000000000000000000"],
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
      format: {
        timestampStyle: "full-timestamps",
      },
    });

    expect(result.text).not.toContain("### 2026-01-01");
    expect(result.text).toContain("2026-01-01 00:00 <Alice> first");
    expect(result.text).toContain("2026-01-01 00:01 last");
  });

  test("exportConversationRange anonymises authors, reactions, and mentions", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice Contact" });
    upsertIdentity(db, { platform: "discord", platformId: "2000000000000000000", displayName: "Bob" });
    const firstId = insertDiscordMessage({
      sourceId: "anonymous-1",
      sourceAccount: "alice",
      title: "Alice and Bob",
      conversationId: channelId,
      content: "Alice typed Bob and mentioned <@2000000000000000000> in this message",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
      rawData: {
        mentions: [{ id: "2000000000000000000", name: "Different Bob Display Name" }],
        reactions: [{
          emoji: { id: null, name: "👍" },
          count: 2,
          users: [
            { id: "1000000000000000000", name: "Alice Contact" },
            { id: "3000000000000000000", name: "Carol" },
          ],
        }],
      },
    });
    const lastId = insertDiscordMessage({
      sourceId: "anonymous-2",
      sourceAccount: "alice",
      title: "Alice and Bob",
      conversationId: channelId,
      content: "Reply from Bob",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:2000000000000000000"],
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
      format: { anonymiseNames: true },
    });

    // A DM/group title is the participants' names, so the heading is rebuilt.
    expect(result.text).toContain("## discord: Person 1, Person 2");
    expect(result.text).not.toContain("Alice and Bob");
    expect(result.text).toContain(
      "00:00 <Person 1> Alice typed Bob and mentioned @Person 2 in this message [reactions: 👍 Person 1, Person 3]",
    );
    expect(result.text).toContain("00:01 <Person 2> Reply from Bob");
    expect(result.text).not.toContain("<Alice Contact>");
    expect(result.text).not.toContain("<Bob>");
  });

  test("exportConversationRange anonymises quoted authors, reactors, and poll voters by identity", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice" });
    upsertIdentity(db, { platform: "discord", platformId: "2000000000000000000", displayName: "Bob" });
    const firstId = insertDiscordMessage({
      sourceId: "9300000000000000001",
      sourceAccount: "alice",
      title: "Alice and Bob",
      conversationId: channelId,
      content: "Which day works?",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
      rawData: {
        author: { id: "1000000000000000000", global_name: "alice_2019" },
        poll: {
          question: { text: "Which day works?" },
          answers: [{ answer_id: 1, poll_media: { text: "Saturday" } }],
          allow_multiselect: false,
          results: { answer_counts: [{ id: 1, count: 1, me_voted: false }], is_finalized: true },
          voters: {
            captured_at: "2026-01-02T00:00:00Z",
            answers: {
              "1": [{ id: "2000000000000000000", name: "bob_2019", username: "bob_2019", avatar: null }],
            },
          },
        },
      },
    });
    const lastId = insertDiscordMessage({
      sourceId: "9300000000000000002",
      sourceAccount: "alice",
      title: "Alice and Bob",
      conversationId: channelId,
      content: "Saturday suits me",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:2000000000000000000"],
      rawData: {
        author: { id: "2000000000000000000", global_name: "bob_2019" },
        message_reference: { message_id: "9300000000000000001" },
        reactions: [{
          emoji: { id: null, name: "🎉" },
          count: 1,
          users: [{ id: "1000000000000000000", name: "alice_2019" }],
        }],
      },
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
      format: { anonymiseNames: true },
    });

    // Person 2 votes in Person 1's poll, then Person 1 reacts to Person 2's
    // reply — the same two people throughout, so no third alias appears.
    expect(result.text).toContain("00:00 <Person 1> [poll: Which day works? — Saturday (1 vote: Person 2)");
    expect(result.text).toContain(
      '00:01 <Person 2> ↪ (to Person 1: "Which day works?") Saturday suits me [reactions: 🎉 Person 1]',
    );
    expect(result.text).not.toContain("Person 3");
    expect(result.text).not.toContain("_2019");
    expect(result.text).not.toContain("Alice");
    expect(result.text).not.toContain("Bob");
  });

  test("exportConversationRange keeps a guild channel heading but reports the real title", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice" });
    const channel = {
      _channel: {
        id: channelId,
        name: "general",
        type: "GuildTextChat",
        guild_id: "9000000000000000100",
        guild_name: "Test Server",
      },
    };
    const firstId = insertDiscordMessage({
      sourceId: "9400000000000000001",
      sourceAccount: "alice",
      title: "Test Server #general",
      conversationId: channelId,
      content: "morning",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
      rawData: channel,
    });
    const lastId = insertDiscordMessage({
      sourceId: "9400000000000000002",
      sourceAccount: "alice",
      title: "Test Server #general",
      conversationId: channelId,
      content: "afternoon",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:1000000000000000000"],
      rawData: channel,
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
      format: { anonymiseNames: true },
    });

    // A channel is named after a place, not its participants.
    expect(result.text).toContain("## discord: Test Server #general");
    expect(result.text).toContain("00:00 <Person 1> morning");
    // The caller still needs to know which conversation they exported.
    expect(result.range.title).toBe("Test Server #general");
  });

  test("exportConversationRange names reactors and quoted authors by resolved contact", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice" });
    upsertIdentity(db, { platform: "discord", platformId: "2000000000000000000", displayName: "Bob" });
    const firstId = insertDiscordMessage({
      sourceId: "9200000000000000001",
      sourceAccount: "alice",
      title: "Alice and Bob",
      conversationId: channelId,
      content: "who is bringing the quiz sheets",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
      // Discord stamps the name it held at capture time, not the contact's name.
      rawData: { author: { id: "1000000000000000000", global_name: "alice_2019" } },
    });
    const lastId = insertDiscordMessage({
      sourceId: "9200000000000000002",
      sourceAccount: "alice",
      title: "Alice and Bob",
      conversationId: channelId,
      content: "I have them",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:2000000000000000000"],
      rawData: {
        author: { id: "2000000000000000000", global_name: "bob_2019" },
        message_reference: { message_id: "9200000000000000001" },
        reactions: [{
          emoji: { id: null, name: "🎉" },
          count: 2,
          users: [
            { id: "1000000000000000000", name: "alice_2019" },
            { id: "4000000000000000000", name: "unknown_reactor" },
          ],
        }],
      },
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
    });

    expect(result.text).toContain(
      '00:01 <Bob> ↪ (to Alice: "who is bringing the quiz sheets") I have them'
        + " [reactions: 🎉 Alice, unknown_reactor]",
    );
    expect(result.text).not.toContain("_2019");
  });

  test("exportConversationRange renders timestamps in the requested time zone", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice" });
    const firstId = insertDiscordMessage({
      sourceId: "tz-1",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "new year",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
    });
    const lastId = insertDiscordMessage({
      sourceId: "tz-2",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "still local evening",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:1000000000000000000"],
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
      format: {
        timeZone: "America/New_York",
      },
    });

    expect(result.text).toContain("### 2025-12-31");
    expect(result.text).toContain("19:00 <Alice> new year");
    expect(result.text).toContain("19:01 still local evening");
    expect(result.text).not.toContain("### 2026-01-01");
  });

  test("exportConversationRange supports reverse endpoint selection", async () => {
    const channelId = "9100000000000000000";
    const firstId = insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "first",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const lastId = insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "last",
      timestamp: "2026-01-01T00:01:00Z",
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: lastId,
      endEventId: firstId,
    });

    expect(result.eventCount).toBe(2);
    expect(result.range.startEventId).toBe(firstId);
    expect(result.range.endEventId).toBe(lastId);
    expect(result.range.requestedStartEventId).toBe(lastId);
    expect(result.range.requestedEndEventId).toBe(firstId);
  });

  test("exportConversationRange treats renamed conversations as canonical by conversation_id", async () => {
    const channelId = "9100000000000000000";
    const firstId = insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "old name",
      conversationId: channelId,
      content: "before rename",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const lastId = insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "new name",
      conversationId: channelId,
      content: "after rename",
      timestamp: "2026-01-02T00:00:00Z",
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
    });

    expect(result.eventCount).toBe(2);
    expect(result.range.conversationId).toBe(channelId);
    expect(result.text).toContain("before rename");
    expect(result.text).toContain("after rename");
    expect(result.text).toContain("## discord: new name");
    expect(result.text).not.toContain("## discord: old name");
  });

  test("exportConversationRange keeps attachment markers alongside caption text", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice" });
    const captionId = insertDiscordMessage({
      sourceId: "cap-1",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "look at this",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
      rawData: { attachments: [{ content_type: "image/png", filename: "shot.png" }] },
    });
    const mediaOnlyId = insertDiscordMessage({
      sourceId: "cap-2",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:1000000000000000000"],
      rawData: { attachments: [{ content_type: "video/mp4", filename: "clip.mp4" }] },
    });

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: captionId,
      endEventId: mediaOnlyId,
    });

    // Caption and attachment marker both survive (previously the text won and
    // the marker was dropped).
    expect(result.text).toContain("look at this [photo]");
    // Attachment-only messages still render the bare marker.
    expect(result.text).toContain("[video]");
  });

  test("exportConversationRange renders reactions by default and allows disabling them", async () => {
    const channelId = "9100000000000000000";
    upsertIdentity(db, { platform: "discord", platformId: "1000000000000000000", displayName: "Alice" });
    const firstId = insertDiscordMessage({
      sourceId: "react-1",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "great work",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:1000000000000000000"],
      rawData: {
        reactions: [
          { emoji: { id: null, name: "😮" }, count: 1, users: [{ id: "2", name: "Bob" }] },
          {
            emoji: { id: "5", name: "pepe" },
            count: 3,
            users: [
              { id: "3", name: "Carol" },
              { id: "4", name: "Dave" },
              { id: "5", name: "Eve" },
            ],
          },
        ],
      },
    });
    const lastId = insertDiscordMessage({
      sourceId: "react-2",
      sourceAccount: "alice",
      title: "Project chat",
      conversationId: channelId,
      content: "thanks",
      timestamp: "2026-01-01T00:01:00Z",
      people: ["discord:1000000000000000000"],
    });

    const withReactions = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
    });
    // Unicode emoji render as-is; custom emoji render as :name:.
    expect(withReactions.text).toContain("great work [reactions: 😮 Bob; :pepe: Carol, Dave, Eve]");

    const withoutReactions = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
      format: { includeReactions: false },
    });
    expect(withoutReactions.text).toContain("great work");
    expect(withoutReactions.text).not.toContain("[reactions:");
  });

  test("exportConversationRange groups Facebook per-person reactions by emoji", async () => {
    const conversationId = "fb-bob";
    // Facebook stores one entry per actor; the export groups actors by emoji.
    const reactions = JSON.stringify({
      reactions: [
        { reaction: "👍", actor: "Bob" },
        { reaction: "👍", actor: "Carol" },
        { reaction: "❤", actor: "Dave" },
      ],
    });
    const firstId = Number(db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
      VALUES ('facebook', 'fb-react-1', 'alice', 'message:dm', '2026-01-01T00:00:00Z', 'Bob', 'nice photo', ?, ?)
    `).run(reactions, conversationId).lastInsertRowid);
    const lastId = Number(db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
      VALUES ('facebook', 'fb-react-2', 'alice', 'message:dm', '2026-01-01T00:01:00Z', 'Bob', 'thanks', '{}', ?)
    `).run(conversationId).lastInsertRowid);

    const result = await exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: lastId,
      format: { includeReactions: true },
    });
    expect(result.text).toContain("nice photo [reactions: 👍 Bob, Carol; ❤ Dave]");
  });

  test("exportConversationRange rejects cross-conversation endpoints", async () => {
    const firstId = insertDiscordMessage({
      sourceId: "m1",
      sourceAccount: "alice",
      title: "One",
      conversationId: "9100000000000000001",
      content: "one",
      timestamp: "2026-01-01T00:00:00Z",
    });
    const secondId = insertDiscordMessage({
      sourceId: "m2",
      sourceAccount: "alice",
      title: "Two",
      conversationId: "9100000000000000002",
      content: "two",
      timestamp: "2026-01-01T00:01:00Z",
    });

    await expect(exportConversationRange(wrapDatabase(db), {
      startEventId: firstId,
      endEventId: secondId,
    })).rejects.toThrow("same conversation");
  });
});
