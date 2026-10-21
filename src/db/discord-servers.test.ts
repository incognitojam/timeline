import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDiscordServer, listDiscordServers } from "./discord-servers";
import { type QueryExecutor, wrapDatabase } from "./pool";
import { initDb } from "./schema";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

let db: Database;

function createRecordingExecutor(database: Database): QueryExecutor & { queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    async query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      queries.push({ sql, params });
      return database.prepare(sql).all(...(params as SQLQueryBindings[])) as T[];
    },
    async get<T>(sql: string, ...params: unknown[]): Promise<T | null> {
      return (database.prepare(sql).get(...(params as SQLQueryBindings[])) as T) ?? null;
    },
  };
}

describe("Discord server queries", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  test("reads channel metadata from conversation summaries without scanning events", async () => {
    const executor = createRecordingExecutor(db);
    await listDiscordServers(executor);

    const metadataQuery = executor.queries[0];
    if (!metadataQuery) throw new Error("Discord channel metadata query was not executed");

    const rows = db
      .prepare(`EXPLAIN QUERY PLAN ${metadataQuery.sql}`)
      .all(...(metadataQuery.params as SQLQueryBindings[])) as Array<{ detail: string }>;
    const plan = rows.map((row) => row.detail).join("\n");

    expect(plan).toContain("idx_conversation_summaries_source_list");
    expect(plan).toContain("SEARCH e USING INTEGER PRIMARY KEY");
    expect(plan).not.toContain("SCAN events");
    expect(plan).not.toContain("CORRELATED SCALAR SUBQUERY");
  });

  test("uses the latest titled event when messages are inserted out of order", async () => {
    const insert = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, title, content,
        raw_data, conversation_id
      ) VALUES ('discord', ?, 'example-account', 'message:guild', ?, ?, 'hello', ?, 'example-channel')
    `);
    const channel = (name: string, guildName: string) => JSON.stringify({
      _channel: {
        id: "example-channel",
        name,
        type: "GuildTextChat",
        guild_id: "900000000000000001",
        guild_name: guildName,
        category: "General",
      },
    });

    insert.run(
      "newer-message",
      "2026-02-01T00:00:00Z",
      "New Server #new-name",
      channel("new-name", "New Server"),
    );
    insert.run(
      "older-message",
      "2026-01-01T00:00:00Z",
      "Old Server #old-name",
      channel("old-name", "Old Server"),
    );

    const servers = await listDiscordServers(wrapDatabase(db));

    expect(servers).toEqual([
      {
        guildId: "900000000000000001",
        name: "New Server",
        iconUrl: null,
        channelCount: 1,
        messageCount: 2,
        firstMessage: "2026-01-01T00:00:00Z",
        lastMessage: "2026-02-01T00:00:00Z",
      },
    ]);
  });

  test("merges participants whose identities link to the same contact", async () => {
    const insert = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, title, content,
        people, raw_data, conversation_id
      ) VALUES (
        'discord', ?, 'example-account', 'message:guild',
        '2026-01-01T00:00:00Z', 'Example Server #general', 'hello', ?,
        '{"_channel":{"guild_id":"900000000000000001","guild_name":"Example Server","name":"general","type":"GuildTextChat"}}',
        'example-channel'
      )
    `);
    insert.run("m1", '["discord:100"]');
    insert.run("m2", '["discord:200"]');
    insert.run("m3", '["discord:200"]');
    insert.run("m4", '["discord:300"]');
    insert.run("m5", '["discord:300"]');

    db.prepare(`INSERT INTO contacts (id, display_name) VALUES (1, 'Alice')`).run();
    db.prepare(`
      INSERT INTO identities (platform, platform_id, display_name, contact_id, avatar_url)
      VALUES ('discord', '100', 'alice_old', 1, 'https://example.com/a.png'),
             ('discord', '200', 'alice_new', 1, NULL),
             ('discord', '300', 'Bob', NULL, NULL)
    `).run();

    const server = await getDiscordServer(wrapDatabase(db), "900000000000000001");

    expect(server?.participants).toEqual([
      { identifier: "discord:200", name: "Alice", contactId: 1, avatarUrl: "https://example.com/a.png", count: 3 },
      { identifier: "discord:300", name: "Bob", contactId: null, avatarUrl: null, count: 2 },
    ]);
  });

  test("uses the conversation index for per-server event aggregates", async () => {
    db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, title, content,
        people, raw_data, conversation_id
      ) VALUES (
        'discord', 'indexed-message', 'example-account', 'message:guild',
        '2026-01-01T00:00:00Z', 'Example Server #general', 'hello',
        '["discord:alice"]',
        '{"_channel":{"guild_id":"900000000000000001","guild_name":"Example Server","name":"general","type":"GuildTextChat"}}',
        'example-channel'
      )
    `).run();

    const executor = createRecordingExecutor(db);
    await getDiscordServer(executor, "900000000000000001");

    const aggregateQueries = executor.queries.filter((query) =>
      query.sql.includes("JOIN event_people") || query.sql.includes("strftime('%Y-%m'"),
    );
    expect(aggregateQueries).toHaveLength(2);

    for (const query of aggregateQueries) {
      const rows = db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .all(...(query.params as SQLQueryBindings[])) as Array<{ detail: string }>;
      const plan = rows.map((row) => row.detail).join("\n");
      expect(plan).toContain("idx_events_conversation_id");
      expect(plan).not.toContain("idx_events_source_timestamp");
      expect(plan).not.toContain("idx_events_source_id");
    }
  });
});
