/**
 * Tests for hydrateEventsById — fetching full event rows from an ID list while
 * preserving caller order (e.g. similarity order from vector search), collapsing
 * duplicates, and accounting for IDs whose rows no longer exist.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { hydrateEventsById, searchTimeline } from "./events";
import { wrapDatabase } from "./pool";
import { initDb } from "./schema";

let db: Database;

function setup(): void {
  db = new Database(":memory:");
  initDb(db);
}

function teardown(): void {
  db.close();
}

function insertEvent(fields: { title?: string; content?: string } = {}): number {
  const result = db
    .prepare(
      `INSERT INTO events (source, source_id, type, timestamp, title, content, raw_data)
       VALUES ('test', ?, 'note', '2026-01-01T00:00:00Z', ?, ?, '{}')`,
    )
    .run(randomUUID(), fields.title ?? null, fields.content ?? null);
  return Number(result.lastInsertRowid);
}

describe("hydrateEventsById", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("collapses duplicate IDs to a single event", async () => {
    const id = insertEvent({ title: "only" });

    const { events, missingCount } = await hydrateEventsById(wrapDatabase(db), [id, id, id]);

    expect(events.map((e) => e.id)).toEqual([id]);
    expect(missingCount).toBe(0);
  });

  test("returns events in the given ID order, not SQL row order", async () => {
    const first = insertEvent({ title: "first" });
    const second = insertEvent({ title: "second" });
    const third = insertEvent({ title: "third" });

    // Request out of ascending order; `WHERE id IN (...)` would return rows in
    // ascending rowid order, so this only passes if the helper re-orders.
    const { events } = await hydrateEventsById(wrapDatabase(db), [third, first, second]);

    expect(events.map((e) => e.id)).toEqual([third, first, second]);
  });

  test("drops IDs with no matching row and counts them in missingCount", async () => {
    const real = insertEvent({ title: "real" });
    const stale = real + 1000; // never inserted

    const { events, missingCount } = await hydrateEventsById(wrapDatabase(db), [real, stale]);

    expect(events.map((e) => e.id)).toEqual([real]);
    expect(missingCount).toBe(1);
  });

  test("applies limit after dropping missing IDs", async () => {
    const a = insertEvent({ title: "a" });
    const b = insertEvent({ title: "b" });
    const c = insertEvent({ title: "c" });
    const stale = c + 1000; // never inserted, sits first in the candidate list

    const { events, missingCount } = await hydrateEventsById(
      wrapDatabase(db),
      [stale, a, b, c],
      { limit: 2 },
    );

    // Limit caps after the stale ID is dropped, so we still get two real events.
    expect(events.map((e) => e.id)).toEqual([a, b]);
    expect(missingCount).toBe(1);
  });

  test("normalizes legacy Google emoji in hydrated fields", async () => {
    const legacy = String.fromCodePoint(0xfe000); // maps to ☀️
    const id = insertEvent({ title: `${legacy} morning`, content: legacy });

    const { events } = await hydrateEventsById(wrapDatabase(db), [id]);

    expect(events[0].title).toBe("☀️ morning");
    expect(events[0].content).toBe("☀️");
  });
});

describe("searchTimeline", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("uses FTS tokens for punctuation in path-like queries", async () => {
    const match = insertEvent({ content: "Run bun src/embeddings/cli.ts index" });
    insertEvent({ content: "Embeddings command reference" });

    const events = await searchTimeline(wrapDatabase(db), {
      query: "embeddings cli.ts",
      limit: 10,
    });

    expect(events.map((event) => event.id)).toContain(match);
  });

  test("keeps quoted punctuation queries exact after FTS narrows candidates", async () => {
    const exact = insertEvent({ content: "Open cli.ts before running the command" });
    insertEvent({ content: "Open cli ts before running the command" });

    const events = await searchTimeline(wrapDatabase(db), {
      query: '"cli.ts"',
      limit: 10,
    });

    expect(events.map((event) => event.id)).toEqual([exact]);
  });

  test("falls back to LIKE for tokenless symbol queries", async () => {
    const emoji = insertEvent({ title: "☀️ morning" });
    const plus = insertEvent({ content: "Use + operator" });

    const emojiEvents = await searchTimeline(wrapDatabase(db), {
      query: '"☀️"',
      limit: 10,
    });
    const plusEvents = await searchTimeline(wrapDatabase(db), {
      query: "+",
      limit: 10,
    });

    expect(emojiEvents.map((event) => event.id)).toContain(emoji);
    expect(plusEvents.map((event) => event.id)).toContain(plus);
  });
});
