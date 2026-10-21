import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { wrapDatabase } from "../db/pool";
import { initDb, type TimelineEvent } from "../db/schema";
import { exportContact, filterLargeGroups } from "./export";

function makeEvent(id: number, sender: string, timestamp: string): TimelineEvent {
  return {
    id,
    source: "discord",
    source_id: `event-${id}`,
    source_account: null,
    type: "event",
    timestamp,
    end_timestamp: null,
    duration_ms: null,
    title: "Project chat",
    content: `Message ${id}`,
    latitude: null,
    longitude: null,
    location_name: null,
    people: JSON.stringify([sender, "Alice", "discord:bob", "Carol", "Dana", "Erin"]),
    tags: null,
    raw_data: "{}",
    imported_at: "2026-01-01T00:00:00Z",
    import_batch: null,
    conversation_id: null,
    source_deleted_observed_at: null,
  };
}

const filterOptions = { groupSize: 5, contextHours: 1, contextMessages: 1 };

describe("filterLargeGroups", () => {
  test("keeps every event from a small group", () => {
    const events = [
      { ...makeEvent(1, "Alice", "2026-01-01T10:00:00Z"), people: JSON.stringify(["Alice", "Bob"]) },
      { ...makeEvent(2, "Bob", "2026-01-01T10:01:00Z"), people: JSON.stringify(["Bob", "Alice"]) },
    ];

    expect(filterLargeGroups(events, new Set(), filterOptions)).toEqual(events);
  });

  test("keeps anchor messages with asymmetric message and time context in large groups", () => {
    const events = [
      makeEvent(1, "Alice", "2026-01-01T10:00:00Z"),
      makeEvent(2, "Carol", "2026-01-01T10:01:00Z"),
      makeEvent(3, "discord:bob", "2026-01-01T10:02:00Z"),
      makeEvent(4, "Dana", "2026-01-01T10:03:00Z"),
      makeEvent(5, "Alice", "2026-01-01T10:30:00Z"),
      makeEvent(6, "Carol", "2026-01-01T12:30:00Z"),
    ];

    expect(filterLargeGroups(events, new Set(["discord:bob"]), filterOptions).map((event) => event.id)).toEqual([
      2,
      3,
      4,
      5,
    ]);
  });
});

describe("exportContact", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
    const contactId = Number(db.prepare("INSERT INTO contacts (display_name) VALUES ('Bob')").run().lastInsertRowid);
    db.prepare("INSERT INTO identities (platform, platform_id, contact_id) VALUES ('discord', 'bob', ?)").run(contactId);

    for (const event of [
      makeEvent(1, "Alice", "2026-01-01T10:00:00Z"),
      makeEvent(2, "Carol", "2026-01-01T10:01:00Z"),
      makeEvent(3, "discord:bob", "2026-01-01T10:02:00Z"),
      makeEvent(4, "Dana", "2026-01-01T10:03:00Z"),
      makeEvent(5, "Alice", "2026-01-01T10:30:00Z"),
      makeEvent(6, "Carol", "2026-01-01T12:30:00Z"),
    ]) {
      db.prepare(`
        INSERT INTO events (
          id, source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.source,
        event.source_id,
        event.source_account,
        event.type,
        event.timestamp,
        event.title,
        event.content,
        event.people,
        event.raw_data,
        event.conversation_id,
      );
    }
  });

  afterEach(() => db.close());

  test("bypasses large-group filtering when all is set", async () => {
    const result = await exportContact(wrapDatabase(db), { names: ["Bob"] }, {
      all: true,
      ...filterOptions,
      compactAuthors: true,
      noSummaries: false,
      fullTimestamps: false,
    });

    expect(result.kind).toBe("export");
    if (result.kind !== "export") throw new Error("Expected a resolved contact export");
    expect(result.events.map((event) => event.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
