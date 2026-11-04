import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { CONVERSATION_SUMMARY_EVENT_COLUMNS, initDb, rebuildConversationSummaries } from "./schema";

type Snapshot = { summaries: unknown[]; titles: unknown[] };

function snapshot(db: Database): Snapshot {
  return {
    summaries: db
      .prepare(`
        SELECT source, source_account, source_account_key, conversation_id, title, message_count,
          first_message, last_message, latest_title_timestamp, latest_title_event_id
        FROM conversation_summaries
        ORDER BY source, source_account_key, conversation_id
      `)
      .all(),
    titles: db
      .prepare(`
        SELECT source, source_account_key, conversation_id, title, first_seen, last_seen, message_count
        FROM conversation_summary_titles
        ORDER BY source, source_account_key, conversation_id, title
      `)
      .all(),
  };
}

// Summaries as a full rebuild computes them, without disturbing the
// trigger-maintained tables.
function rebuiltSnapshot(db: Database): Snapshot {
  db.exec("SAVEPOINT rebuilt_snapshot");
  try {
    rebuildConversationSummaries(db);
    return snapshot(db);
  } finally {
    db.exec("ROLLBACK TO rebuilt_snapshot");
    db.exec("RELEASE rebuilt_snapshot");
  }
}

function expectMatchesRebuild(db: Database, context: string): void {
  const maintained = snapshot(db);
  const rebuilt = rebuiltSnapshot(db);
  if (!Bun.deepEquals(maintained, rebuilt)) {
    throw new Error(`summaries diverged from rebuild after ${context}\n${JSON.stringify({ maintained, rebuilt }, null, 2)}`);
  }
}

// mulberry32: small seeded PRNG so failures reproduce.
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOURCES = ["alpha", "beta"];
const ACCOUNTS = ["acct-a", "acct-b"];
const CONVERSATIONS = ["thread-1", "thread-2", "thread-3"];
const ELIGIBLE_TYPES = ["message:dm", "sms:sent", "test:message:user"];
const TYPES = [...ELIGIBLE_TYPES, "comment"];
const TITLES = ["Alice", "Bob", "Carol"];
// Few distinct values, so ties on first/last/latest are common.
const TIMESTAMPS = [
  "2026-01-01T00:00:00Z",
  "2026-01-01T00:00:01Z",
  "2026-01-02T00:00:00Z",
  "2026-01-03T00:00:00Z",
];

function insertEvent(db: Database, row: Record<string, string | number | null>): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...Object.values(row));
}

function seedConversation(db: Database): void {
  for (let i = 0; i < 6; i++) {
    insertEvent(db, {
      source: "alpha",
      source_id: `seed-${i}`,
      source_account: "acct-a",
      type: "message:dm",
      timestamp: TIMESTAMPS[i % TIMESTAMPS.length] ?? null,
      title: i < 3 ? "Alice" : "Bob",
      content: `body ${i}`,
      raw_data: "{}",
      conversation_id: i % 2 === 0 ? "thread-1" : "thread-2",
    });
  }
}

describe("conversation summary triggers", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  it("match a full rebuild across random inserts, updates and deletes", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = prng(seed);
      const pick = <T>(values: readonly T[]): T => {
        const value = values[Math.floor(random() * values.length)];
        if (value === undefined) throw new Error("pick from empty list");
        return value;
      };
      const maybeNull = <T>(values: readonly T[]): T | null => (random() < 0.15 ? null : pick(values));
      let nextSourceId = 0;
      db.exec("DELETE FROM events");

      for (let step = 0; step < 150; step++) {
        const ids = (db.prepare("SELECT id FROM events").all() as Array<{ id: number }>).map((row) => row.id);
        const op = ids.length < 4 ? 0 : random();
        let description: string;
        if (op < 0.3) {
          // Inserts must satisfy the insert-only guards: eligible rows need an
          // account and a conversation_id.
          const row = {
            source: pick(SOURCES),
            source_id: `event-${nextSourceId++}`,
            source_account: pick(ACCOUNTS),
            type: pick(TYPES),
            timestamp: maybeNull(TIMESTAMPS),
            title: maybeNull(TITLES),
            content: "body",
            raw_data: "{}",
            conversation_id: pick(CONVERSATIONS),
          };
          insertEvent(db, row);
          description = `insert ${JSON.stringify(row)}`;
        } else if (op < 0.75) {
          // Update a random subset of columns on one row, or on every row of a
          // conversation (the bulk rename/re-import shape).
          const assignments: Record<string, string | number | null> = {};
          const candidates: Record<string, () => string | number | null> = {
            source: () => pick(SOURCES),
            source_account: () => (random() < 0.1 ? null : pick(ACCOUNTS)),
            conversation_id: () => maybeNull(CONVERSATIONS),
            type: () => pick(TYPES),
            title: () => maybeNull(TITLES),
            timestamp: () => maybeNull(TIMESTAMPS),
            raw_data: () => JSON.stringify({ step }),
            content: () => `content ${step}`,
          };
          for (const [column, value] of Object.entries(candidates)) {
            if (random() < 0.3) assignments[column] = value();
          }
          if (Object.keys(assignments).length === 0) assignments.title = maybeNull(TITLES);
          const setSql = Object.keys(assignments).map((column) => `${column} = ?`).join(", ");
          if (random() < 0.3) {
            const conversation = pick(CONVERSATIONS);
            db.prepare(`UPDATE OR IGNORE events SET ${setSql} WHERE conversation_id = ?`).run(...Object.values(assignments), conversation);
            description = `bulk update of ${conversation} with ${JSON.stringify(assignments)}`;
          } else {
            const id = pick(ids);
            db.prepare(`UPDATE OR IGNORE events SET ${setSql} WHERE id = ?`).run(...Object.values(assignments), id);
            description = `update of ${id} with ${JSON.stringify(assignments)}`;
          }
        } else if (op < 0.82) {
          const id = pick(ids);
          db.prepare("UPDATE events SET id = (SELECT MAX(id) + 1 FROM events) WHERE id = ?").run(id);
          description = `id change of ${id}`;
        } else if (op < 0.95) {
          const id = pick(ids);
          db.prepare("DELETE FROM events WHERE id = ?").run(id);
          description = `delete of ${id}`;
        } else {
          const conversation = pick(CONVERSATIONS);
          db.prepare("DELETE FROM events WHERE conversation_id = ?").run(conversation);
          description = `bulk delete of ${conversation}`;
        }
        expectMatchesRebuild(db, `seed ${seed} step ${step}: ${description}`);
      }
    }
  });

  it("match a full rebuild after any events column changes", () => {
    // Pins CONVERSATION_SUMMARY_EVENT_COLUMNS: if the rebuild starts reading a
    // column the update trigger does not watch, changing that column leaves
    // the maintained summaries stale and this fails.
    const columns = db.prepare("SELECT name, type, \"notnull\" FROM pragma_table_info('events')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    for (const column of columns) {
      const values: Array<string | number | null> = column.notnull || column.name === "id" ? [] : [null];
      if (column.name === "id") values.push(1000);
      else if (column.type === "INTEGER" || column.type === "REAL") values.push(42);
      else if (column.type === "JSON") values.push("[]", "[\"Alice\"]");
      else values.push("2030-01-01T00:00:00Z", "other");

      for (const value of values) {
        db.exec("DELETE FROM events");
        seedConversation(db);
        if (column.name === "id") {
          db.prepare("UPDATE events SET id = id + ?").run(value);
        } else {
          db.prepare(`UPDATE OR IGNORE events SET ${column.name} = ? WHERE source_id IN ('seed-0', 'seed-5')`).run(value);
        }
        expectMatchesRebuild(db, `setting ${column.name} to ${JSON.stringify(value)}`);
      }
    }
  });

  it("skip updates that change no summary column", () => {
    seedConversation(db);
    db.exec("UPDATE conversation_summaries SET updated_at = 'untouched'");

    // Importers upsert with `SET title = excluded.title, raw_data = ...`, so a
    // listed column whose value is unchanged must not count as a change.
    db.exec("UPDATE events SET raw_data = '{\"refreshed\":true}', content = 'new body', title = title, timestamp = timestamp");
    const untouched = db.prepare("SELECT COUNT(*) AS count FROM conversation_summaries WHERE updated_at = 'untouched'").get() as {
      count: number;
    };
    expect(untouched.count).toBe(2);

    db.exec("UPDATE events SET title = 'Renamed' WHERE conversation_id = 'thread-1'");
    const summaries = db.prepare("SELECT conversation_id, title, updated_at <> 'untouched' AS touched FROM conversation_summaries ORDER BY conversation_id").all();
    expect(summaries).toEqual([
      { conversation_id: "thread-1", title: "Renamed", touched: 1 },
      { conversation_id: "thread-2", title: "Bob", touched: 0 },
    ]);
    expectMatchesRebuild(db, "rename");
  });

  it("break latest-title ties on undated events by id", () => {
    for (const sourceId of ["undated-1", "undated-2"]) {
      insertEvent(db, {
        source: "alpha",
        source_id: sourceId,
        source_account: "acct-a",
        type: "message:dm",
        timestamp: null,
        title: "Alice",
        raw_data: "{}",
        conversation_id: "thread-1",
      });
    }
    // Re-adding the lower-id event must not displace the higher-id one.
    db.exec("UPDATE events SET title = 'Bob' WHERE source_id = 'undated-1'");
    const summary = db.prepare("SELECT title FROM conversation_summaries").get();
    expect(summary).toEqual({ title: "Alice" });
    expectMatchesRebuild(db, "undated rename");
  });

  it("replace a stale update trigger on an existing database", () => {
    seedConversation(db);
    const current = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'conversation_summaries_au'").get() as {
      sql: string;
    }).sql;
    // Stand-in for the previous definition: fires on any column and does
    // nothing useful, so a missed upgrade shows up as stale summaries.
    db.exec("DROP TRIGGER conversation_summaries_au");
    db.exec("CREATE TRIGGER conversation_summaries_au AFTER UPDATE ON events BEGIN SELECT 1; END");

    initDb(db);

    const upgraded = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'conversation_summaries_au'").get() as {
      sql: string;
    }).sql;
    expect(upgraded).toBe(current);
    expectMatchesRebuild(db, "upgrade");

    db.exec("UPDATE events SET title = 'Renamed', timestamp = '2026-02-01T00:00:00Z' WHERE source_id IN ('seed-1', 'seed-4')");
    db.exec("UPDATE events SET conversation_id = 'thread-3' WHERE source_id = 'seed-0'");
    expectMatchesRebuild(db, "updates after upgrade");
  });
});
