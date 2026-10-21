import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initAppStateDb } from "./db/app-state";
import { QUERY_TIMEOUT_MS, QueryTimeoutError, type QueryExecutor, wrapDatabase } from "./db/pool";
import { initDb, type TimelineEvent } from "./db/schema";
import { formatEvents, registerTools, resolveContact, type RegisterToolsOptions } from "./mcp-tools";

type ToolHandlerExtra = {
  sessionId?: string;
  requestId?: string | number;
};
type ToolHandler = (
  args: Record<string, unknown>,
  extra?: ToolHandlerExtra,
) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;

/**
 * Capture every tool handler that registerTools wires up, so the tests can
 * invoke them directly with the same code path the MCP transports use.
 */
function captureHandlers(
  database: Database,
  options: RegisterToolsOptions = {},
  queryExecutor: QueryExecutor = wrapDatabase(database),
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerTools(fakeServer, queryExecutor, database, options);
  return handlers;
}

let db: Database;

function setup(): void {
  db = new Database(":memory:");
  initDb(db);
}

function teardown(): void {
  db.close();
}

function makeContact(displayName: string): number {
  const r = db.prepare("INSERT INTO contacts (display_name) VALUES (?)").run(displayName);
  return Number(r.lastInsertRowid);
}

function linkIdentity(platform: string, platformId: string, contactId: number, displayName?: string): void {
  db.prepare(`
    INSERT INTO identities (platform, platform_id, display_name, contact_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      contact_id = excluded.contact_id,
      display_name = COALESCE(excluded.display_name, identities.display_name)
  `).run(platform, platformId, displayName ?? null, contactId);
}

function setIdentityEventCount(platform: string, platformId: string, eventCount: number): void {
  db.prepare("UPDATE identities SET event_count = ? WHERE platform = ? AND platform_id = ?")
    .run(eventCount, platform, platformId);
}

function makeEvent(partial: Partial<TimelineEvent> & Pick<TimelineEvent, "source" | "type">): TimelineEvent {
  return {
    id: 0,
    source: partial.source,
    source_id: null,
    source_account: partial.source_account ?? null,
    type: partial.type,
    timestamp: partial.timestamp ?? "2026-05-06T08:09:53.525Z",
    end_timestamp: null,
    duration_ms: partial.duration_ms ?? null,
    title: partial.title ?? null,
    content: partial.content ?? null,
    people: partial.people ?? null,
    tags: null,
    location_name: null,
    latitude: null,
    longitude: null,
    raw_data: partial.raw_data ?? null,
    import_batch: null,
  } as TimelineEvent;
}

function insertTranscriptEvent({
  content,
  conversationId,
  timestamp,
  people = JSON.stringify(["discord:alice"]),
}: {
  content: string;
  conversationId: string | null;
  timestamp: string;
  people?: string;
}): number {
  const result = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "discord",
    `message-${content}`,
    "test",
    conversationId ? "message:dm" : "note",
    timestamp,
    "Alice and Bob",
    content,
    people,
    "{}",
    conversationId,
  );
  return Number(result.lastInsertRowid);
}

describe("formatEvents — Discord mention resolution", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("resolves linked Discord sender to <Name>", async () => {
    const alice = makeContact("Alice Example");
    linkIdentity("discord", "900000000000000001", alice);

    const events = [makeEvent({
      source: "discord",
      type: "message:guild",
      content: "Hello world",
      people: JSON.stringify(["discord:900000000000000001"]),
    })];

    const out = await formatEvents(wrapDatabase(db), events);
    expect(out).toContain("<Alice Example>");
    expect(out).not.toContain("<discord:900000000000000001>");
  });

  test("resolves <@id> mentions in Discord content to @Name", async () => {
    const alice = makeContact("Alice Example");
    const bob = makeContact("Bob Example");
    linkIdentity("discord", "900000000000000001", alice);
    linkIdentity("discord", "900000000000000002", bob);

    const events = [makeEvent({
      source: "discord",
      type: "message:guild",
      content: "Hello <@900000000000000002>, please review the example plan.",
      people: JSON.stringify(["discord:900000000000000001"]),
    })];

    const out = await formatEvents(wrapDatabase(db), events);
    expect(out).toContain("<Alice Example>");
    expect(out).toContain("@Bob Example");
    expect(out).not.toContain("<@900000000000000002>");
  });

  test("falls back to short id when mention is unresolved", async () => {
    const alice = makeContact("Alice Example");
    linkIdentity("discord", "900000000000000001", alice);

    const events = [makeEvent({
      source: "discord",
      type: "message:guild",
      content: "Pinging <@999888777666>",
      people: JSON.stringify(["discord:900000000000000001"]),
    })];

    const out = await formatEvents(wrapDatabase(db), events);
    expect(out).toContain("<Alice Example>");
    expect(out).toContain("@user:9998…");
  });

  test("leaves opaque sender prefix when sender has no contact link", async () => {
    const events = [makeEvent({
      source: "discord",
      type: "message:guild",
      content: "Hi",
      people: JSON.stringify(["discord:111111111111111111"]),
    })];

    const out = await formatEvents(wrapDatabase(db), events);
    expect(out).toContain("<discord:111111111111111111>");
  });

  test("leaves non-Discord content alone", async () => {
    const events = [makeEvent({
      source: "facebook",
      type: "message",
      content: "Plain message <@123> not a Discord mention",
      people: JSON.stringify(["facebook:name:Alice"]),
    })];

    const out = await formatEvents(wrapDatabase(db), events);
    expect(out).toContain("<@123>");
  });

  test("appends embed markers to message content", async () => {
    const events = [makeEvent({
      source: "discord",
      type: "message:guild",
      content: "https://example.com/post",
      people: JSON.stringify(["discord:111111111111111111"]),
      raw_data: JSON.stringify({
        embeds: [
          {
            type: "link",
            url: "https://example.com/post",
            title: "Example post",
            description: "A useful description",
          },
        ],
      }),
    })];

    const out = await formatEvents(wrapDatabase(db), events);
    expect(out).toContain(
      "https://example.com/post [embed: Example post — A useful description]",
    );
  });

  test("renders Discord call and sticker markers", async () => {
    const events = [
      makeEvent({
        source: "discord",
        type: "message:group:call",
        title: "General",
        source_account: "1",
        people: JSON.stringify(["discord:111111111111111111"]),
        raw_data: JSON.stringify({ call: { participants: ["1", "2"], ended_timestamp: "2026-05-06T08:13:05.525Z" } }),
      }),
      makeEvent({
        source: "discord",
        type: "message:dm:call",
        title: "Alex",
        source_account: "1",
        people: JSON.stringify(["discord:111111111111111111"]),
        raw_data: JSON.stringify({ call: { participants: ["2"], ended_timestamp: "2026-05-06T08:13:05.525Z" } }),
      }),
      makeEvent({
        source: "discord",
        type: "message:guild:sticker",
        content: "A sticker with text",
        people: JSON.stringify(["discord:111111111111111111"]),
        raw_data: JSON.stringify({
          sticker_items: [
            { id: "sticker-1", name: "Wave", format_type: 1 },
            { id: "sticker-2", format_type: 1 },
          ],
        }),
      }),
    ];

    const out = await formatEvents(wrapDatabase(db), events);

    expect(out).toContain("[call: 3m 12s]");
    expect(out).toContain("[missed call]");
    expect(out).toContain("A sticker with text [sticker: Wave] [sticker]");
  });

  test("returns 'No events found.' for empty input", async () => {
    const out = await formatEvents(wrapDatabase(db), []);
    expect(out).toBe("No events found.");
  });

  test("prepends #<id> to every event line so agents can deep-link", async () => {
    const events = [
      makeEvent({ source: "spotify", type: "listen:track", title: "Track A" }),
      makeEvent({ source: "spotify", type: "listen:track", title: "Track B" }),
    ];
    events[0].id = 42;
    events[1].id = 1337;

    const out = await formatEvents(wrapDatabase(db), events);
    const lines = out.split("\n");
    expect(lines[0].startsWith("#42 ")).toBe(true);
    expect(lines[1].startsWith("#1337 ")).toBe(true);
  });
});

describe("get_schema", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("documents the self contact column", async () => {
    const handlers = captureHandlers(db);
    const result = await handlers.get("get_schema")!({});

    expect(result.content[0].text).toContain("id, display_name, notes, hidden, date_of_birth, is_self");
  });
});

describe("MCP transcript export tools", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("exports a full conversation transcript", async () => {
    insertTranscriptEvent({
      conversationId: "conversation-1",
      timestamp: "2026-05-06T08:09:53.525Z",
      content: "Alice says hello with the complete untruncated message.",
    });
    insertTranscriptEvent({
      conversationId: "conversation-1",
      timestamp: "2026-05-06T08:10:53.525Z",
      content: "Bob replies with the complete conversation transcript.",
      people: JSON.stringify(["discord:bob"]),
    });

    const handlers = captureHandlers(db);
    expect(handlers.has("export_conversation")).toBe(true);

    const conversation = await handlers.get("export_conversation")!({
      conversation_id: "conversation-1",
      start_date: "2026-05-06T08:09:53.525Z",
      end_date: "2026-05-06T08:10:53.525Z",
    });
    expect(conversation.content[0].text).toContain("Times in UTC.");
    expect(conversation.content[0].text).toContain("Transcript tokens:");
    expect(conversation.content[0].text).toContain("Alice says hello with the complete untruncated message.");
    expect(conversation.content[0].text).toContain("Bob replies with the complete conversation transcript.");

  });

  function insertWindowEvents(conversationId: string): number[] {
    return Array.from({ length: 7 }, (_, index) => insertTranscriptEvent({
      conversationId,
      timestamp: `2026-05-06T08:0${index}:00.000Z`,
      content: `Message ${index + 1}.`,
    }));
  }

  test("centers an event-id transcript window around a middle event", async () => {
    const eventIds = insertWindowEvents("conversation-middle");
    const handlers = captureHandlers(db);
    const result = await handlers.get("export_conversation")!({ event_id: eventIds[3], limit: 3 });
    const text = result.content[0].text;

    expect(text).toContain(`Showing 3 of 7 events around event #${eventIds[3]}.`);
    expect(text).not.toContain("Message 2.");
    expect(text).toContain("Message 3.");
    expect(text).toContain("Message 4.");
    expect(text).toContain("Message 5.");
    expect(text).not.toContain("Message 6.");
    expect(text.indexOf("Message 3.")).toBeLessThan(text.indexOf("Message 4."));
    expect(text.indexOf("Message 4.")).toBeLessThan(text.indexOf("Message 5."));
  });

  test("extends an event-id transcript window forward near the start", async () => {
    const eventIds = insertWindowEvents("conversation-start");
    const handlers = captureHandlers(db);
    const result = await handlers.get("export_conversation")!({ event_id: eventIds[0], limit: 4 });
    const text = result.content[0].text;

    expect(text).toContain(`Showing 4 of 7 events around event #${eventIds[0]}.`);
    expect(text).toContain("Message 1.");
    expect(text).toContain("Message 4.");
    expect(text).not.toContain("Message 5.");
  });

  test("uses the newest tail for an event-id transcript window near the end", async () => {
    const eventIds = insertWindowEvents("conversation-end");
    const handlers = captureHandlers(db);
    const result = await handlers.get("export_conversation")!({ event_id: eventIds[6], limit: 4 });
    const text = result.content[0].text;

    expect(text).toContain(`Showing 4 of 7 events around event #${eventIds[6]}.`);
    expect(text).not.toContain("Message 3.");
    expect(text).toContain("Message 4.");
    expect(text).toContain("Message 7.");
  });

  test("lets explicit dates override event-id transcript centering", async () => {
    const eventIds = insertWindowEvents("conversation-date-bounds");
    const handlers = captureHandlers(db);
    const result = await handlers.get("export_conversation")!({
      event_id: eventIds[2],
      limit: 4,
      start_date: "2026-05-06T08:04:00.000Z",
      end_date: "2026-05-06T08:05:00.000Z",
    });
    const text = result.content[0].text;

    expect(text).not.toContain("around event");
    expect(text).not.toContain("Message 3.");
    expect(text).toContain("Message 5.");
    expect(text).toContain("Message 6.");
  });

  test("reports the newest transcript slice when the limit is hit", async () => {
    insertTranscriptEvent({
      conversationId: "conversation-3",
      timestamp: "2026-05-06T08:00:00.000Z",
      content: "Oldest message.",
    });
    insertTranscriptEvent({
      conversationId: "conversation-3",
      timestamp: "2026-05-06T08:01:00.000Z",
      content: "Middle message.",
    });
    insertTranscriptEvent({
      conversationId: "conversation-3",
      timestamp: "2026-05-06T08:02:00.000Z",
      content: "Newest message.",
    });

    const handlers = captureHandlers(db);
    const result = await handlers.get("export_conversation")!({ conversation_id: "conversation-3", limit: 2 });

    expect(result.content[0].text).toContain("Showing most recent 2 of 3 events.");
    expect(result.content[0].text).not.toContain("Oldest message.");
    expect(result.content[0].text).toContain("Middle message.");
    expect(result.content[0].text).toContain("Newest message.");
    expect(result.content[0].text.indexOf("Middle message.")).toBeLessThan(result.content[0].text.indexOf("Newest message."));
  });

  test("requires exactly one conversation selector", async () => {
    const handlers = captureHandlers(db);
    const result = await handlers.get("export_conversation")!({
      conversation_id: "conversation-4",
      event_id: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exactly one of conversation_id or event_id");
  });
});

describe("MCP tool handler — run_sql timeout", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("explains database query timeouts", async () => {
    const timeoutExecutor: QueryExecutor = {
      query<T>() {
        return Promise.reject(new QueryTimeoutError(QUERY_TIMEOUT_MS)) as Promise<T[]>;
      },
      get<T>() {
        return Promise.resolve(null) as Promise<T | null>;
      },
    };
    const handlers = captureHandlers(db, {}, timeoutExecutor);

    const result = await handlers.get("run_sql")!({ sql: "SELECT id FROM events" });

    // The contract is that a timeout takes the dedicated branch rather than the
    // generic `Error: <message>` path, so the caller can tell the database gave
    // up from a dead connection. Assert that shape, not the exact copy.
    const text = result.content[0].text;
    expect(result.isError).toBe(true);
    expect(text.startsWith(`Error: Database query timeout after ${QUERY_TIMEOUT_MS}ms\n`)).toBe(true);
    expect(text).toContain("do not retry it unchanged");
    expect(text).toContain("\nTips:\n");
  });

  test("keeps ordinary SQL errors unchanged", async () => {
    const handlers = captureHandlers(db);

    const result = await handlers.get("run_sql")!({ sql: "SELECT * FROM missing_events" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: no such table: missing_events");
  });
});

describe("resolveContact — identity-aware fallback", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("resolves a bare Discord snowflake to its linked contact", async () => {
    const bob = makeContact("Bob Example");
    linkIdentity("discord", "900000000000000002", bob);

    const result = await resolveContact(wrapDatabase(db), "900000000000000002");
    if (result.error) throw new Error(`expected success, got error: ${result.error[0].text}`);
    expect(result.contact.id).toBe(bob);
    expect(result.contact.display_name).toBe("Bob Example");
  });

  test("resolves an explicit platform:id input", async () => {
    const bob = makeContact("Bob Example");
    linkIdentity("discord", "900000000000000002", bob);

    const result = await resolveContact(wrapDatabase(db), "discord:900000000000000002");
    if (result.error) throw new Error(`expected success, got error: ${result.error[0].text}`);
    expect(result.contact.id).toBe(bob);
  });

  test("returns not-found when the snowflake exists but isn't linked", async () => {
    db.prepare(`INSERT INTO identities (platform, platform_id, display_name) VALUES (?, ?, ?)`)
      .run("discord", "100200300", "Unknown");

    const result = await resolveContact(wrapDatabase(db), "100200300");
    if (!result.error) throw new Error("expected error");
    expect(result.error[0].text).toContain("not found");
  });

  test("returns ambiguity error when bare id matches multiple contacts", async () => {
    const alice = makeContact("Alice");
    const bob = makeContact("Bob");
    linkIdentity("discord", "shared-id-123", alice);
    linkIdentity("steam", "shared-id-123", bob);

    const result = await resolveContact(wrapDatabase(db), "shared-id-123");
    if (!result.error) throw new Error("expected error");
    expect(result.error[0].text).toContain("multiple contacts");
    expect(result.error[0].text).toContain("Alice");
    expect(result.error[0].text).toContain("Bob");
  });

  test("name search still wins when present", async () => {
    const alice = makeContact("Alice");
    linkIdentity("discord", "111", alice);

    const result = await resolveContact(wrapDatabase(db), "Alice");
    if (result.error) throw new Error(`expected success, got error: ${result.error[0].text}`);
    expect(result.contact.id).toBe(alice);
  });
});

/**
 * Regression tests for the workflow described in the original MCP feedback:
 * given a Discord snowflake pulled out of a `<@id>` mention, the agent should
 * be able to identify the tagged user via list_contacts or get_contact_info
 * without falling back to run_sql.
 */
describe("MCP tool handlers — identity-aware contact lookup workflow", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("list_contacts returns the linked contact when search is a Discord snowflake", async () => {
    const bob = makeContact("Bob Example");
    linkIdentity("discord", "900000000000000002", bob, "bob_user");

    const handlers = captureHandlers(db);
    const result = await handlers.get("list_contacts")!({ search: "900000000000000002" });

    expect(result.content[0].text).toContain("Bob Example");
    expect(result.content[0].text).toContain("1 platform · 0 active identities · 0 events");
    expect(result.content[0].text).not.toContain("undefined aliases");
    expect(result.content[0].text).not.toContain("No contacts found");
  });

  test("list_contacts counts platforms and active identities instead of raw identity rows", async () => {
    const carol = makeContact("Carol Example");
    linkIdentity("discord", "900000000000000003", carol, "Carol");
    linkIdentity("discord", "900000000000000004", carol, "Carol Alternate");
    linkIdentity("monzo", "tx-alice", carol, "Carol Example");
    linkIdentity("monzo", "tx-bob", carol, "EXAMPLE C");
    setIdentityEventCount("discord", "900000000000000003", 3);
    setIdentityEventCount("monzo", "tx-alice", 4);

    const handlers = captureHandlers(db);
    const result = await handlers.get("list_contacts")!({ search: "Carol" });

    expect(result.content[0].text).toContain("Carol Example");
    expect(result.content[0].text).toContain("2 platforms · 2 active identities · 7 events");
    expect(result.content[0].text).not.toContain("4 identities");
  });

  test("list_contacts says no match when the snowflake is unknown", async () => {
    const handlers = captureHandlers(db);
    const result = await handlers.get("list_contacts")!({ search: "999999999999999999" });
    expect(result.content[0].text).toBe("No contacts found.");
  });

  test("list_contacts prefers a name match over the identity fallback", async () => {
    const alice = makeContact("Alice");
    linkIdentity("discord", "111", alice);

    const handlers = captureHandlers(db);
    const result = await handlers.get("list_contacts")!({ search: "Alice" });
    expect(result.content[0].text).toContain("Alice");
    // The fallback path would have to dedupe; if it ran we'd see "111" or "discord:" in the text.
    expect(result.content[0].text).not.toContain("discord:111");
  });

  test("get_contact_info resolves a Discord snowflake in one call", async () => {
    const bob = makeContact("Bob Example");
    linkIdentity("discord", "900000000000000002", bob, "bob_user");

    const handlers = captureHandlers(db);
    const result = await handlers.get("get_contact_info")!({ contact: "900000000000000002" });

    expect(result.content[0].text).toContain("Bob Example");
    expect(result.content[0].text).toContain("discord");
  });

  test("semantic_search returns a setup message when embeddings are not configured", async () => {
    // No embeddings option: the handler must short-circuit before it tries to
    // open embeddings.db / reach an embedding endpoint.
    const handlers = captureHandlers(db);
    const handler = handlers.get("semantic_search");
    expect(handler).toBeDefined();
    const result = await handler!({ query: "anything" });
    expect(result.content[0].text).toContain("not configured");
    expect(result.content[0].text).toContain("[embeddings]");
  });

  // Bun only allows Database.setCustomSQLite() before the first opened
  // database, so isolate the sqlite-vec success case in a fresh process.
  test("semantic_search returns formatted events from a seeded embeddings index", async () => {
    const script = String.raw`
      import { Database } from "bun:sqlite";
      import { mkdtempSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { DbPool, wrapDatabase } from "./src/db/pool.ts";
      import { initDb } from "./src/db/schema.ts";
      import { contentHash, EVENT_LEAN_PROFILE } from "./src/embeddings/content.ts";
      import {
        ensureContentProfile,
        ensureModelProfile,
        getEmbeddingsDb,
        initEmbeddingsDb,
        insertVector,
        upsertDocument,
      } from "./src/embeddings/db.ts";
      import { configureBunSqliteForSqliteVec } from "./src/embeddings/sqlite-vec.ts";
      import { registerTools } from "./src/mcp-tools.ts";

      const dir = mkdtempSync(join(tmpdir(), "timeline-mcp-semantic-"));
      const embeddingsDbPath = join(dir, "embeddings.db");
      const server = Bun.serve({
        port: 0,
        fetch: async request => {
          const body = await request.json();
          if (body.model !== "test-model") throw new Error("unexpected model");
          if (body.input[0] !== "query: coffee") throw new Error("unexpected input " + JSON.stringify(body.input));
          return Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] });
        },
      });

      try {
        process.env.TIMELINE_EMBEDDINGS_DB_PATH = embeddingsDbPath;
        configureBunSqliteForSqliteVec();

        const timelineDb = new Database(":memory:");
        const embeddingsDb = getEmbeddingsDb(embeddingsDbPath);
        try {
          initDb(timelineDb);
          let sqliteVecReady = true;
          try {
            initEmbeddingsDb(embeddingsDb);
          } catch (error) {
            console.log("SKIP sqlite-vec unavailable: " + (error instanceof Error ? error.message : String(error)));
            sqliteVecReady = false;
          }

          if (sqliteVecReady) {
            const legacyThumbsUp = String.fromCodePoint(0xFEB97);
            const unicodeThumbsUp = String.fromCodePoint(0x1F44D);
            timelineDb.prepare(
              "INSERT INTO events (id, source, source_id, source_account, type, timestamp, title, content, raw_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).run(
              42,
              "facebook",
              "semantic-42",
              null,
              "post",
              "2026-05-06T08:09:53.525Z",
              "Cafe " + legacyThumbsUp,
              "Coffee planning " + legacyThumbsUp,
              "{}",
            );

            const contentProfile = ensureContentProfile(embeddingsDb, EVENT_LEAN_PROFILE);
            const modelProfile = ensureModelProfile(embeddingsDb, {
              name: "test-model:3",
              provider: "openai-compatible",
              endpoint: server.url + "v1/embeddings",
              model: "test-model",
              dimensions: 3,
              api_key_env: null,
              document_prefix: "",
            });
            const document = upsertDocument(embeddingsDb, {
              sourceKind: "event",
              sourceKey: "42",
              title: "Cafe",
              snippet: "Coffee planning",
              startTimestamp: "2026-05-06T08:09:53.525Z",
              endTimestamp: null,
              contentProfileId: contentProfile.id,
              contentProfileVersion: contentProfile.version,
              renderedContent: "Coffee planning",
              contentHash: contentHash("Coffee planning"),
              eventIds: [42],
            });
            insertVector(embeddingsDb, document.id, modelProfile.id, [1, 0, 0]);

            const handlers = new Map();
            const fakeServer = {
              tool: (name, _description, _schema, handler) => handlers.set(name, handler),
            };
            // The service's path: vector search on its own pool worker.
            const vectorPool = await DbPool.create(embeddingsDbPath, { workers: 1, vectorSearch: true });
            registerTools(fakeServer, wrapDatabase(timelineDb), timelineDb, {
              semanticSearch: {
                config: { base_url: server.url + "v1", model: "test-model", dimensions: 3, query_prefix: "query: " },
                embeddingsDb: async () => vectorPool,
              },
            });
            const result = await handlers.get("semantic_search")({ query: "coffee", limit: 1, full_content: false });
            await vectorPool.closeAndWait();
            const text = result.content[0].text;
            if (!text.includes("1 event(s) most similar")) throw new Error(text);
            if (!text.includes("#42 [facebook/post]")) throw new Error(text);
            if (!text.includes(unicodeThumbsUp)) throw new Error(text);
            if (text.includes(legacyThumbsUp)) throw new Error(text);
            console.log("semantic_search success path ok");
          }
        } finally {
          timelineDb.close();
          embeddingsDb.close();
        }
      } finally {
        server.stop(true);
        rmSync(dir, { recursive: true, force: true });
      }
    `;

    const proc = Bun.spawn([process.execPath, "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    if (proc.exitCode !== 0) {
      throw new Error(`semantic_search child test failed with ${proc.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
    if (stdout.includes("SKIP sqlite-vec unavailable")) return;
    expect(stderr).toBe("");
    expect(stdout).toContain("semantic_search success path ok");
  });

  test("query_events resolves Discord <@id> mentions inline (full agent workflow)", async () => {
    const alice = makeContact("Alice Example");
    const bob = makeContact("Bob Example");
    linkIdentity("discord", "900000000000000001", alice);
    linkIdentity("discord", "900000000000000002", bob);

    db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "discord",
      "msg-1",
      "test-account",
      "message:guild",
      "2026-05-06T08:09:53.525Z",
      "#shopping",
      "Hello <@900000000000000002>, please review the example plan.",
      JSON.stringify(["discord:900000000000000001"]),
      "{}",
      "shopping-channel",
    );

    const handlers = captureHandlers(db);
    const result = await handlers.get("query_events")!({ contact: "Alice Example", limit: 10 });

    const text = result.content[0].text;
    expect(text).toContain("<Alice Example>");
    expect(text).toContain("@Bob Example");
    // The raw snowflake mention should not survive into the rendered output.
    expect(text).not.toContain("<@900000000000000002>");
  });
});

function insertEvent(partial: {
  source: string;
  type: string;
  timestamp: string;
  title?: string;
  content?: string;
  people?: string[];
}): number {
  const r = db.prepare(`
    INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
  `).run(
    partial.source,
    `msg-${Math.random().toString(36).slice(2)}`,
    "test-account",
    partial.type,
    partial.timestamp,
    partial.title ?? null,
    partial.content ?? null,
    partial.people ? JSON.stringify(partial.people) : null,
    `${partial.source}:${partial.title ?? partial.type}`,
  );
  return Number(r.lastInsertRowid);
}

/**
 * Regression tests for a previously observed MCP session where
 * query_events(query, date) returned events from other days: the text-search
 * and contact branches dropped `date` instead of narrowing to that day.
 */
describe("query_events — date filter with query/contact", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("query + date only returns events from that day", async () => {
    insertEvent({ source: "discord", type: "message:guild", timestamp: "2026-07-01T10:00:00.000Z", content: "board games banter" });
    insertEvent({ source: "discord", type: "message:guild", timestamp: "2026-07-03T10:00:00.000Z", content: "board games night" });

    const handlers = captureHandlers(db);
    const result = await handlers.get("query_events")!({ query: "games", date: "2026-07-03" });

    const text = result.content[0].text;
    expect(text).toContain("2026-07-03");
    expect(text).not.toContain("2026-07-01");
  });

  test("contact + date only returns events from that day", async () => {
    const alice = makeContact("Alice");
    linkIdentity("discord", "111", alice);
    insertEvent({ source: "discord", type: "message:dm", timestamp: "2026-07-01T10:00:00.000Z", content: "hello from tuesday", people: ["discord:111"] });
    insertEvent({ source: "discord", type: "message:dm", timestamp: "2026-07-03T10:00:00.000Z", content: "hello from thursday", people: ["discord:111"] });

    const handlers = captureHandlers(db);
    const result = await handlers.get("query_events")!({ contact: "Alice", date: "2026-07-03" });

    const text = result.content[0].text;
    expect(text).toContain("hello from thursday");
    expect(text).not.toContain("hello from tuesday");
  });

  test("contact + query applies text search before the result limit", async () => {
    const alice = makeContact("Alice");
    linkIdentity("discord", "111", alice);
    insertEvent({
      source: "discord",
      type: "message:dm",
      timestamp: "2026-07-01T10:00:00.000Z",
      content: "contactsearchneedle",
      people: ["discord:111"],
    });
    insertEvent({
      source: "discord",
      type: "message:dm",
      timestamp: "2026-07-03T10:00:00.000Z",
      content: "unrelated newer event",
      people: ["discord:111"],
    });

    const handlers = captureHandlers(db);
    const result = await handlers.get("query_events")!({
      contact: "Alice",
      query: "contactsearchneedle",
      limit: 1,
    });

    const text = result.content[0].text;
    expect(text).toContain("contactsearchneedle");
    expect(text).not.toContain("unrelated newer event");
  });
});

describe("get_context — source filters", () => {
  beforeEach(setup);
  afterEach(teardown);

  function seedWindow(): number {
    const centerId = insertEvent({ source: "discord", type: "message:guild", timestamp: "2026-07-03T12:00:00.000Z", content: "match starts at 7" });
    insertEvent({ source: "claude-code", type: "claude-code:message:user", timestamp: "2026-07-03T12:30:00.000Z", content: "You are the review coordinator" });
    insertEvent({ source: "spotify", type: "listen:track", timestamp: "2026-07-03T13:00:00.000Z", title: "Some Track" });
    return centerId;
  }

  test("exclude_source drops the listed sources from the window", async () => {
    const centerId = seedWindow();

    const handlers = captureHandlers(db);
    const result = await handlers.get("get_context")!({ event_id: centerId, exclude_source: "claude-code" });

    const text = result.content[0].text;
    expect(text).toContain("match starts at 7");
    expect(text).toContain("spotify");
    expect(text).not.toContain("claude-code");
  });

  test("source restricts the window to the listed sources", async () => {
    const centerId = seedWindow();

    const handlers = captureHandlers(db);
    const result = await handlers.get("get_context")!({ event_id: centerId, source: "discord,spotify" });

    const text = result.content[0].text;
    expect(text).toContain("match starts at 7");
    expect(text).toContain("spotify");
    expect(text).not.toContain("claude-code");
  });
});

describe("get_summary — source filters", () => {
  beforeEach(setup);
  afterEach(teardown);

  function seedDay(): void {
    insertEvent({ source: "conductor", type: "conductor:message:assistant", timestamp: "2026-07-07T10:00:00.000Z", title: "workspace: Do the thing" });
    insertEvent({ source: "discord", type: "message:guild", timestamp: "2026-07-07T11:00:00.000Z", title: "General", content: "F1 chat" });
    insertEvent({ source: "spotify-friends", type: "listen:track:friend", timestamp: "2026-07-07T12:00:00.000Z", title: "Some Track" });
  }

  test("exclude_source drops the listed sources from a day summary", async () => {
    seedDay();

    const handlers = captureHandlers(db);
    const result = await handlers.get("get_summary")!({ date: "2026-07-07", exclude_source: "conductor,spotify-friends" });

    const text = result.content[0].text;
    expect(text).toContain("discord/message:guild");
    expect(text).not.toContain("conductor");
    expect(text).not.toContain("spotify-friends");
  });

  test("source restricts a day summary to the listed sources", async () => {
    seedDay();

    const handlers = captureHandlers(db);
    const result = await handlers.get("get_summary")!({ date: "2026-07-07", source: "discord" });

    const text = result.content[0].text;
    expect(text).toContain("discord/message:guild");
    expect(text).not.toContain("conductor");
    expect(text).not.toContain("spotify-friends");
  });

  test("exclude_source applies to global stats and recomputes the total", async () => {
    seedDay();

    const handlers = captureHandlers(db);
    const result = await handlers.get("get_summary")!({ exclude_source: "conductor" });

    const text = result.content[0].text;
    expect(text).toContain("Total events: 2");
    expect(text).toContain("discord");
    expect(text).toContain("spotify-friends");
    expect(text).not.toContain("conductor");
  });
});

describe("MCP tool handlers — MCP session history", () => {
  let appDb: Database;

  beforeEach(() => {
    setup();
    appDb = new Database(":memory:");
    appDb.exec("PRAGMA foreign_keys = ON");
    initAppStateDb(appDb);
  });

  afterEach(() => {
    appDb.close();
    teardown();
  });

  function insertSession(id: string, transport: "http" | "stdio", clientName: string): void {
    appDb.prepare(`
      INSERT INTO mcp_sessions (id, transport, client_name, created_at, last_activity_at)
      VALUES (?, ?, ?, '2026-07-03 10:00:00', '2026-07-03 10:05:00')
    `).run(id, transport, clientName);
  }

  function insertCall(options: {
    sessionId: string;
    toolName: string;
    argsJson: string;
    resultText: string;
    isError: boolean;
    createdAt: string;
  }): void {
    appDb.prepare(`
      INSERT INTO mcp_tool_calls (
        session_id, tool_name, args_json, args_chars, result_text, result_chars,
        is_error, truncated, duration_ms, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 12, ?)
    `).run(
      options.sessionId,
      options.toolName,
      options.argsJson,
      options.argsJson.length,
      options.resultText,
      options.resultText.length,
      options.isError ? 1 : 0,
      options.createdAt,
    );
  }

  test("list_mcp_sessions lists summaries and get_mcp_session defaults to caller session", async () => {
    insertSession("history-session-1", "http", "Test Client");
    insertCall({
      sessionId: "history-session-1",
      toolName: "get_summary",
      argsJson: "{\"date\":\"2026-07-03\"}",
      resultText: "summary",
      isError: false,
      createdAt: "2026-07-03 10:04:00",
    });

    const handlers = captureHandlers(db, { appStateDb: appDb });
    const listResult = await handlers.get("list_mcp_sessions")!({});
    expect(listResult.content[0].text).toContain("`history-session-1`");
    expect(listResult.content[0].text).toContain("calls: 1");
    expect(listResult.content[0].text).toContain("errors: 0");

    const detailResult = await handlers.get("get_mcp_session")!(
      {},
      { sessionId: "history-session-1", requestId: "req-1" },
    );
    expect(detailResult.content[0].text).toContain("# MCP session `history-session-1`");
    expect(detailResult.content[0].text).toContain("`get_summary`");
    expect(detailResult.content[0].text).toContain("\"date\": \"2026-07-03\"");
  });

  test("get_mcp_session reports missing session ids and unknown sessions as errors", async () => {
    const handlers = captureHandlers(db, { appStateDb: appDb });

    const missingId = await handlers.get("get_mcp_session")!({});
    expect(missingId.isError).toBe(true);
    expect(missingId.content[0].text).toContain("session_id is required");

    const notFound = await handlers.get("get_mcp_session")!({ session_id: "missing-session" });
    expect(notFound.isError).toBe(true);
    expect(notFound.content[0].text).toContain("MCP session not found: missing-session");
  });

  test("get_mcp_session defaults to the configured stdio session id when SDK extra has none", async () => {
    insertSession("stdio-self-session", "stdio", "Stdio Client");
    insertCall({
      sessionId: "stdio-self-session",
      toolName: "query_events",
      argsJson: "{\"query\":\"coffee\"}",
      resultText: "ok",
      isError: false,
      createdAt: "2026-07-03 10:04:00",
    });

    const handlers = captureHandlers(db, {
      appStateDb: appDb,
      defaultSessionId: () => "stdio-self-session",
    });
    const detailResult = await handlers.get("get_mcp_session")!(
      {},
      { requestId: "stdio-req-1" },
    );

    expect(detailResult.isError).toBeUndefined();
    expect(detailResult.content[0].text).toContain("# MCP session `stdio-self-session`");
    expect(detailResult.content[0].text).toContain("`query_events`");
  });

  test("get_mcp_session can create the default stdio session before lookup", async () => {
    const handlers = captureHandlers(db, {
      appStateDb: appDb,
      defaultSessionId: () => {
        insertSession("stdio-new-session", "stdio", "Stdio Client");
        return "stdio-new-session";
      },
    });

    const detailResult = await handlers.get("get_mcp_session")!(
      {},
      { requestId: "stdio-req-2" },
    );

    expect(detailResult.isError).toBeUndefined();
    expect(detailResult.content[0].text).toContain("# MCP session `stdio-new-session`");
    expect(detailResult.content[0].text).toContain("No tool calls recorded for this session.");
  });

  test("search_mcp_tool_calls filters across sessions", async () => {
    insertSession("history-session-a", "http", "Client A");
    insertSession("history-session-b", "stdio", "Client B");
    insertCall({
      sessionId: "history-session-a",
      toolName: "query_events",
      argsJson: "{\"query\":\"coffee\"}",
      resultText: "ok",
      isError: false,
      createdAt: "2026-07-03 09:00:00",
    });
    insertCall({
      sessionId: "history-session-a",
      toolName: "run_sql",
      argsJson: "{\"sql\":\"bad\"}",
      resultText: "Error: bad SQL",
      isError: true,
      createdAt: "2026-07-03 10:00:00",
    });
    insertCall({
      sessionId: "history-session-b",
      toolName: "query_events",
      argsJson: "{\"query\":\"tea\"}",
      resultText: "Error: bad args",
      isError: true,
      createdAt: "2026-07-03 11:00:00",
    });

    const handlers = captureHandlers(db, { appStateDb: appDb });
    const crossSession = await handlers.get("search_mcp_tool_calls")!({
      tool_name: "query_events",
      errors_only: true,
      since: "2026-07-03T10:30:00Z",
    });
    expect(crossSession.content[0].text).toContain("- Session: `history-session-b`");
    expect(crossSession.content[0].text).toContain("`query_events`");
    expect(crossSession.content[0].text).not.toContain("history-session-a");

    const scoped = await handlers.get("search_mcp_tool_calls")!({
      session_id: "history-session-a",
      errors_only: true,
    });
    expect(scoped.content[0].text).toContain("`run_sql`");
    expect(scoped.content[0].text).not.toContain("`query_events`");

    const emptySession = await handlers.get("search_mcp_tool_calls")!({
      session_id: "",
    });
    expect(emptySession.content[0].text).toContain("No matching tool calls found.");
    expect(emptySession.content[0].text).not.toContain("history-session-a");
    expect(emptySession.content[0].text).not.toContain("history-session-b");
  });

  test("search_mcp_tool_calls rejects loose since values before querying", async () => {
    const handlers = captureHandlers(db, { appStateDb: appDb });
    const result = await handlers.get("search_mcp_tool_calls")!({
      since: "July 3, 2026",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("since must be an ISO timestamp with timezone");
  });
});
