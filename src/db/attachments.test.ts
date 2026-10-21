import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAttachmentDetail } from "./attachments";
import { type QueryExecutor } from "./pool";
import { initDb } from "./schema";

interface RecordedQuery {
  method: "query" | "get";
  sql: string;
  params: unknown[];
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

describe("attachment detail", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  test("looks up a single attachment before joining its event", async () => {
    const event = db.prepare(`
      INSERT INTO events (source, source_id, type, timestamp, title, raw_data)
      VALUES ('test', 'event-1', 'event', '2026-01-01T00:00:00Z', 'Test event', '{}')
    `).run();
    const attachment = db.prepare(`
      INSERT INTO attachments (
        event_id, source, source_id, content_hash, filename, mime_type, storage_path, status
      ) VALUES (?, 'test', 'attachment-1', 'hash-1', 'image.png', 'image/png', 'test/image.png', 'stored')
    `).run(event.lastInsertRowid);
    const executor = createRecordingExecutor(db);

    const detail = await getAttachmentDetail(executor, Number(attachment.lastInsertRowid));

    expect(detail?.filename).toBe("image.png");
    const lookup = executor.queries.find((query) => query.method === "get");
    if (!lookup) throw new Error("Attachment detail lookup was not recorded");
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${lookup.sql}`)
      .all(...(lookup.params as SQLQueryBindings[])) as { detail: string }[];
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("SEARCH a USING INTEGER PRIMARY KEY (rowid=?)");
    expect(details).toContain("SEARCH e USING INTEGER PRIMARY KEY (rowid=?)");
    expect(details).not.toContain("SCAN e");
  });
});
