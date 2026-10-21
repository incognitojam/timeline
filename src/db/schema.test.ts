import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { conversationEventEligibilityClause, conversationTypeClause } from "./conversation-types";
import { initDb } from "./schema";

function schemaSql(db: Database, type: "index" | "trigger", name: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name) as { sql: string } | null;
  if (!row) {
    throw new Error(`Missing ${type}: ${name}`);
  }
  return row.sql;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// The events_timestamp_iso guard rejects non-ISO timestamp / end_timestamp
// values: a bare 'YYYY-MM-DD' is silently excluded from the day-view range
// query (`timestamp >= 'DATE T00:00:00'`) and breaks lexicographic comparisons
// that assume the columns are ISO.
describe("events timestamp guard", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  const insert = (sourceId: string, timestamp: string | null) =>
    db
      .prepare(
        `INSERT INTO events (source, source_id, type, timestamp, title, raw_data)
         VALUES ('test', ?, 'event', ?, 't', '{}')`
      )
      .run(sourceId, timestamp);

  const insertWithEnd = (
    sourceId: string,
    timestamp: string | null,
    endTimestamp: string | null
  ) =>
    db
      .prepare(
        `INSERT INTO events (source, source_id, type, timestamp, end_timestamp, title, raw_data)
         VALUES ('test', ?, 'event', ?, ?, 't', '{}')`
      )
      .run(sourceId, timestamp, endTimestamp);

  it("accepts a full ISO timestamp", () => {
    expect(() => insert("ok", "2026-05-04T00:00:00Z")).not.toThrow();
  });

  it("accepts a null timestamp (dateless events such as Reddit votes)", () => {
    expect(() => insert("null-ts", null)).not.toThrow();
  });

  it("rejects a bare YYYY-MM-DD date", () => {
    expect(() => insert("bare", "2026-05-04")).toThrow(/full ISO datetime/);
  });

  it("rejects a space-separated datetime (also sorts before the day's lower bound)", () => {
    expect(() => insert("spaced", "2026-05-04 12:00:00")).toThrow(/full ISO datetime/);
  });

  it("is INSERT-only: an UPDATE may still set a bare date, so legacy rows stay fixable", () => {
    insert("legacy", "2026-05-04T00:00:00Z");
    expect(() =>
      db.prepare("UPDATE events SET timestamp = '2026-05-04' WHERE source_id = 'legacy'").run()
    ).not.toThrow();
  });

  it("accepts a full ISO end_timestamp", () => {
    expect(() =>
      insertWithEnd("end-ok", "2026-05-04T00:00:00Z", "2026-05-04T01:00:00Z")
    ).not.toThrow();
  });

  it("accepts a null end_timestamp (durationless events)", () => {
    expect(() => insertWithEnd("end-null", "2026-05-04T00:00:00Z", null)).not.toThrow();
  });

  it("rejects a bare YYYY-MM-DD end_timestamp even when timestamp is valid ISO", () => {
    expect(() => insertWithEnd("end-bare", "2026-05-04T00:00:00Z", "2026-05-04")).toThrow(
      /end_timestamp must be a full ISO datetime/
    );
  });

  it("rejects a space-separated end_timestamp", () => {
    expect(() =>
      insertWithEnd("end-spaced", "2026-05-04T00:00:00Z", "2026-05-04 12:00:00")
    ).toThrow(/end_timestamp must be a full ISO datetime/);
  });
});

describe("attachment_descriptions schema", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  it("stores descriptions keyed by content hash and model", () => {
    db.prepare(
      `INSERT INTO attachment_descriptions (content_hash, model, description, created_at, duration_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("hash-one", "vision-model", "A diagram on a whiteboard.", "2026-01-01T00:00:00Z", 123);

    const row = db.prepare(
      `SELECT content_hash, model, description, created_at, duration_ms
       FROM attachment_descriptions
       WHERE content_hash = ? AND model = ?`,
    ).get("hash-one", "vision-model");

    expect(row).toEqual({
      content_hash: "hash-one",
      model: "vision-model",
      description: "A diagram on a whiteboard.",
      created_at: "2026-01-01T00:00:00Z",
      duration_ms: 123,
    });
  });
});

describe("contacts is_self", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  it("allows at most one self contact", () => {
    db.prepare("INSERT INTO contacts (display_name, is_self) VALUES (?, 1)").run("Alice");
    // Any number of non-self contacts is fine
    db.prepare("INSERT INTO contacts (display_name) VALUES (?)").run("Bob");
    db.prepare("INSERT INTO contacts (display_name) VALUES (?)").run("Carol");

    expect(() =>
      db.prepare("INSERT INTO contacts (display_name, is_self) VALUES (?, 1)").run("Dave")
    ).toThrow();
  });
});

// Date-range aggregations (`WHERE timestamp >= ? GROUP BY source`) must run
// off the covering (source, timestamp) index: the planner otherwise satisfies
// the GROUP BY from a source-ordered index and walks every table row to check
// the timestamp, which times out MCP run_sql on the full events table.
describe("events date-range aggregation plan", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  it("answers date-filtered GROUP BY source from the covering index", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT source, COUNT(id) FROM events
         WHERE timestamp >= '2026-07-01' GROUP BY source`
      )
      .all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "COVERING INDEX idx_events_source_timestamp"
    );
  });

  it("drops the prefix-redundant idx_events_source on existing databases", () => {
    db.exec(`CREATE INDEX idx_events_source ON events(source)`);
    initDb(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_source'")
      .get();
    expect(row).toBeNull();
  });
});

describe("render sweep schema", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  it("stores source render watermarks and indexes source/id paging", () => {
    db.prepare(
      "INSERT INTO render_sweep_state (source, version, last_event_id, updated_at) VALUES (?, ?, ?, ?)",
    ).run("discord", 1, 42, "2026-07-27T12:00:00Z");

    expect(db.prepare("SELECT * FROM render_sweep_state").get()).toEqual({
      source: "discord",
      version: 1,
      last_event_id: 42,
      updated_at: "2026-07-27T12:00:00Z",
    });
    expect(normalizeSql(schemaSql(db, "index", "idx_events_source_id"))).toBe(
      "CREATE INDEX idx_events_source_id ON events(source, id)",
    );
  });
});

describe("conversation summary schema", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  it("uses the shared conversation event type clauses for indexes and triggers", () => {
    const conversationIndex = normalizeSql(schemaSql(db, "index", "idx_events_conversations"));
    const conversationIdIndex = normalizeSql(schemaSql(db, "index", "idx_events_conversation_id"));
    const insertTrigger = normalizeSql(schemaSql(db, "trigger", "conversation_summaries_ai"));
    const deleteTrigger = normalizeSql(schemaSql(db, "trigger", "conversation_summaries_ad"));
    const updateTrigger = normalizeSql(schemaSql(db, "trigger", "conversation_summaries_au"));

    expect(conversationIndex).toContain(
      normalizeSql(`WHERE ${conversationEventEligibilityClause()}`)
    );
    expect(conversationIdIndex).toContain(
      normalizeSql(`WHERE conversation_id IS NOT NULL AND ${conversationTypeClause()}`)
    );
    expect(insertTrigger).toContain(
      normalizeSql(`WHEN ${conversationEventEligibilityClause("NEW.")} AND NEW.conversation_id IS NOT NULL`)
    );
    expect(deleteTrigger).toContain(
      normalizeSql(`WHEN ${conversationEventEligibilityClause("OLD.")} AND OLD.conversation_id IS NOT NULL`)
    );
    expect(updateTrigger).toContain(
      normalizeSql(
        `WHEN ${conversationEventEligibilityClause("OLD.")} AND OLD.conversation_id IS NOT NULL OR ${conversationEventEligibilityClause("NEW.")} AND NEW.conversation_id IS NOT NULL`
      )
    );
  });

  it("updates summaries only for shared conversation event types", () => {
    const insert = db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
      VALUES ('test', ?, 'tester', ?, '2026-01-01T00:00:00Z', ?, ?, '{}', ?)
    `);
    insert.run("message", "message:dm", "Messages", "included message", "messages-thread");
    insert.run("sms", "sms:sent", "SMS", "included sms", "sms-thread");
    insert.run("comment", "comment", "Comments", "excluded comment", null);
    insert.run("memory", "claude:memory", "Memories", "excluded memory", null);

    const rows = db
      .query<{ title: string; message_count: number }, []>(`
        SELECT title, message_count
        FROM conversation_summaries
        ORDER BY title
      `)
      .all();

    expect(rows).toEqual([
      { title: "Messages", message_count: 1 },
      { title: "SMS", message_count: 1 },
    ]);
  });

  it("rejects new conversation events without a source account", () => {
    const insert = db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
      VALUES ('test', ?, ?, 'message:dm', '2026-01-01T00:00:00Z', 'Messages', 'body', '{}', 'schema-source-account-thread')
    `);

    expect(() => insert.run("null-account", null)).toThrow(/non-empty source_account/);
    expect(() => insert.run("empty-account", "")).toThrow(/non-empty source_account/);
    expect(() => insert.run("blank-account", "   ")).toThrow(/non-empty source_account/);
    expect(() => insert.run("ok-account", "tester")).not.toThrow();
  });

  it("rejects new conversation events without a conversation_id", () => {
    const insert = db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
      VALUES ('test', ?, 'tester', 'message:dm', '2026-01-01T00:00:00Z', 'Messages', 'body', '{}', ?)
    `);

    expect(() => insert.run("null-conversation", null)).toThrow(/conversation_id/);
    expect(() => insert.run("ok-conversation", "schema-conversation-thread")).not.toThrow();
  });

  it("migrates old title-keyed summaries to conversation_id summaries", () => {
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
      );

      CREATE TABLE conversation_summaries (
        source TEXT NOT NULL,
        source_account TEXT,
        source_account_key TEXT NOT NULL,
        key_kind TEXT NOT NULL CHECK (key_kind IN ('conversation_id', 'title')),
        conversation_key TEXT NOT NULL,
        conversation_id TEXT,
        title TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        first_message TEXT,
        last_message TEXT,
        latest_title_timestamp TEXT,
        latest_title_event_id INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (source, source_account_key, key_kind, conversation_key)
      );

      CREATE TABLE conversation_summary_titles (
        source TEXT NOT NULL,
        source_account_key TEXT NOT NULL,
        key_kind TEXT NOT NULL CHECK (key_kind IN ('conversation_id', 'title')),
        conversation_key TEXT NOT NULL,
        title TEXT NOT NULL,
        first_seen TEXT,
        last_seen TEXT,
        message_count INTEGER NOT NULL,
        PRIMARY KEY (source, source_account_key, key_kind, conversation_key, title)
      );

      INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, conversation_id)
      VALUES ('facebook', 'fb1', 'alice', 'message:dm', '2026-01-01T00:00:00Z', 'Bob', '{}', NULL);

      INSERT INTO conversation_summaries (
        source, source_account, source_account_key, key_kind, conversation_key,
        conversation_id, title, message_count
      ) VALUES ('facebook', 'alice', 'value:alice', 'title', 'Bob', NULL, 'Bob', 1);
    `);

    initDb(existing);
    initDb(existing);

    const event = existing
      .prepare("SELECT conversation_id FROM events WHERE source_id = 'fb1'")
      .get() as { conversation_id: string };
    expect(event.conversation_id).toBe("legacy:Bob");

    const summaryColumns = existing
      .prepare("SELECT name FROM pragma_table_info('conversation_summaries') ORDER BY cid")
      .all() as Array<{ name: string }>;
    expect(summaryColumns.map((row) => row.name)).not.toContain("key_kind");
    expect(summaryColumns.map((row) => row.name)).not.toContain("conversation_key");

    const titleColumns = existing
      .prepare("SELECT name FROM pragma_table_info('conversation_summary_titles') ORDER BY cid")
      .all() as Array<{ name: string }>;
    expect(titleColumns.map((row) => row.name)).not.toContain("key_kind");
    expect(titleColumns.map((row) => row.name)).not.toContain("conversation_key");

    const summary = existing
      .prepare(`
        SELECT conversation_id, title, message_count
        FROM conversation_summaries
        WHERE source = 'facebook'
      `)
      .get() as { conversation_id: string; title: string; message_count: number };
    expect(summary).toEqual({
      conversation_id: "legacy:Bob",
      title: "Bob",
      message_count: 1,
    });

    const title = existing
      .prepare(`
        SELECT conversation_id, title, message_count
        FROM conversation_summary_titles
        WHERE source = 'facebook'
      `)
      .get() as { conversation_id: string; title: string; message_count: number };
    expect(title).toEqual({
      conversation_id: "legacy:Bob",
      title: "Bob",
      message_count: 1,
    });

    existing.close();
  });
});
