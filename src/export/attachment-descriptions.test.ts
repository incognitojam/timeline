import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { type QueryExecutor, wrapDatabase } from "../db/pool";
import { initDb, type TimelineEvent } from "../db/schema";
import {
  latestAttachmentDescriptionSelect,
  loadAttachmentDescriptionsForEvents,
} from "./attachment-descriptions";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

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

describe("attachment description selection", () => {
  let db: Database;
  let event: TimelineEvent;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
    const result = db.prepare(`
      INSERT INTO events (source, source_id, type, timestamp, title, raw_data)
      VALUES ('test', 'event-1', 'event', '2026-01-01T00:00:00Z', 'Test event', '{}')
    `).run();
    event = db.prepare("SELECT * FROM events WHERE id = ?").get(result.lastInsertRowid) as TimelineEvent;
  });

  afterEach(() => db.close());

  function insertDescription(contentHash: string, model: string, description: string, createdAt: string): void {
    db.prepare(`
      INSERT INTO attachment_descriptions (content_hash, model, description, created_at)
      VALUES (?, ?, ?, ?)
    `).run(contentHash, model, description, createdAt);
  }

  async function selectedDescription(contentHash: string, preferredModels?: readonly string[]): Promise<string | null> {
    db.prepare(`
      INSERT INTO attachments (event_id, source, source_id, content_hash, mime_type, storage_path, status)
      VALUES (?, 'test', ?, ?, 'image/png', 'test/image.png', 'stored')
    `).run(event.id, `attachment-${contentHash}`, contentHash);
    const descriptions = await loadAttachmentDescriptionsForEvents(
      wrapDatabase(db),
      [event],
      preferredModels,
    );
    return descriptions.get(event.id)?.find((entry) => entry.contentHash === contentHash)?.description ?? null;
  }

  test("uses configured order before creation time", async () => {
    insertDescription("preferred", "preferred-model", "Preferred description", "2026-01-01T00:00:00Z");
    insertDescription("preferred", "comparison-model", "Newer comparison description", "2026-01-02T00:00:00Z");

    expect(await selectedDescription("preferred", ["preferred-model", "comparison-model"])).toBe(
      "Preferred description",
    );
  });

  test("binds configured model strings instead of interpolating them", () => {
    const model = "model' OR 1 = 1 --";
    const select = latestAttachmentDescriptionSelect("ad.description", [model]);

    expect(select.sql).not.toContain(model);
    expect(select.params).toEqual([model]);
  });

  test("ranks unlisted models after configured models and by recency among themselves", async () => {
    insertDescription("configured", "preferred-model", "Preferred description", "2026-01-01T00:00:00Z");
    insertDescription("configured", "unlisted-model", "Newer unlisted description", "2026-01-02T00:00:00Z");
    expect(await selectedDescription("configured", ["preferred-model"])).toBe("Preferred description");

    insertDescription("unlisted", "older-model", "Older unlisted description", "2026-01-01T00:00:00Z");
    insertDescription("unlisted", "newer-model", "Newer unlisted description", "2026-01-02T00:00:00Z");
    expect(await selectedDescription("unlisted", ["preferred-model"])).toBe("Newer unlisted description");
  });

  test("uses the legacy created_at then model ordering without a preference", async () => {
    insertDescription("fallback", "alpha-model", "Alpha description", "2026-01-02T00:00:00Z");
    insertDescription("fallback", "zeta-model", "Zeta description", "2026-01-02T00:00:00Z");

    expect(await selectedDescription("fallback")).toBe("Zeta description");
  });

  test("uses the event index for ranges with three or more events", async () => {
    const executor = createRecordingExecutor(db);
    await loadAttachmentDescriptionsForEvents(executor, [
      event,
      { ...event, id: event.id + 1 },
      { ...event, id: event.id + 2 },
    ]);

    const query = executor.queries[0];
    if (!query) throw new Error("Attachment description query was not executed");
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...(query.params as SQLQueryBindings[])) as { parent: number; detail: string }[];
    const details = plan.map((row) => row.detail).join("\n");
    const topLevelDetails = plan.filter((row) => row.parent === 0).map((row) => row.detail).join("\n");

    expect(details).toContain("USING INDEX idx_attachments_event");
    expect(details).not.toContain("USING INDEX idx_attachments_status");
    expect(topLevelDetails).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });
});
