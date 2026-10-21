/**
 * Tests for event_people verification and rebuild functionality
 *
 * Tests cover:
 * 1. Verification passes when data is synchronized
 * 2. Detection of orphaned rows (event deleted but event_people entry remains)
 * 3. Detection of stale rows (person removed from event but entry remains)
 * 4. Detection of missing rows (person added but not in event_people)
 * 5. Detection of metadata mismatches (source/timestamp out of sync)
 * 6. Rebuild fixes all discrepancies
 * 7. Atomic rebuild - readers never see empty table
 *
 * Uses the real database schema (initDb) to ensure tests catch any schema drift.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { populateEventPeople } from "../db/queries";
import { initDb } from "../db/schema";

// Test database setup
let db: Database;

function setupTestDatabase(): void {
  db = new Database(":memory:");

  // Use the real schema - this ensures tests catch any schema changes
  initDb(db);
}

/**
 * Helper to insert test events with required fields
 * The real schema has NOT NULL constraints we need to satisfy
 */
function insertEvent(options: {
  source: string;
  type: string;
  timestamp?: string | null;
  title?: string;
  people?: string[] | null;
}): number {
  const stmt = db.prepare(`
    INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sourceId = `test-${Date.now()}-${Math.random()}`;
  const result = stmt.run(
    options.source,
    sourceId,
    "test-account",
    options.type,
    options.timestamp ?? null,
    options.title ?? null,
    options.people ? JSON.stringify(options.people) : null,
    "{}", // minimal raw_data to satisfy NOT NULL
    options.type.includes("message") && options.title ? `${options.source}:${options.title}:${sourceId}` : null,
  );
  return Number(result.lastInsertRowid);
}

function teardownTestDatabase(): void {
  db.close();
}

// Verification helper functions (extracted from verify-event-people.ts logic)
function countOrphanedRows(testDb: Database): number {
  const result = testDb.prepare(`
    SELECT COUNT(*) as count
    FROM event_people ep
    WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = ep.event_id)
  `).get() as { count: number };
  return result.count;
}

function countStaleRows(testDb: Database): number {
  const result = testDb.prepare(`
    SELECT COUNT(*) as count
    FROM event_people ep
    JOIN events e ON e.id = ep.event_id
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(COALESCE(e.people, '[]')) p
      WHERE p.value = ep.person AND p.value IS NOT NULL AND p.value != ''
    )
  `).get() as { count: number };
  return result.count;
}

function countMissingRows(testDb: Database): number {
  const result = testDb.prepare(`
    SELECT COUNT(*) as count
    FROM events e, json_each(e.people) p
    WHERE e.people IS NOT NULL
      AND p.value IS NOT NULL
      AND p.value != ''
      AND NOT EXISTS (
        SELECT 1 FROM event_people ep
        WHERE ep.event_id = e.id AND ep.person = p.value
      )
  `).get() as { count: number };
  return result.count;
}

function countMismatchedMetadata(testDb: Database): number {
  const result = testDb.prepare(`
    SELECT COUNT(*) as count
    FROM event_people ep
    JOIN events e ON e.id = ep.event_id
    WHERE ep.source != e.source
      OR (ep.timestamp IS NULL AND e.timestamp IS NOT NULL)
      OR (ep.timestamp IS NOT NULL AND e.timestamp IS NULL)
      OR ep.timestamp != e.timestamp
  `).get() as { count: number };
  return result.count;
}

function getEventPeopleCount(testDb: Database): number {
  return (testDb.prepare("SELECT COUNT(*) as count FROM event_people").get() as { count: number }).count;
}

function getEventsCount(testDb: Database): number {
  return (testDb.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number }).count;
}

describe("verify-event-people", () => {
  beforeEach(() => {
    setupTestDatabase();
  });

  afterEach(() => {
    teardownTestDatabase();
  });

  describe("verification with synchronized data", () => {
    test("passes verification when event_people is empty and no events have people", () => {
      // Insert events without people field
      insertEvent({ source: "test", type: "test:event", timestamp: "2024-01-01T12:00:00Z", title: "Event 1" });
      insertEvent({ source: "test", type: "test:event", timestamp: "2024-01-02T12:00:00Z", title: "Event 2" });

      expect(countOrphanedRows(db)).toBe(0);
      expect(countStaleRows(db)).toBe(0);
      expect(countMissingRows(db)).toBe(0);
      expect(countMismatchedMetadata(db)).toBe(0);
    });

    test("passes verification when triggers properly maintain event_people", () => {
      // Insert events with people - triggers should populate event_people
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat with Alice",
        people: ["Alice", "Bob"],
      });
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-02T12:00:00Z",
        title: "Chat with Charlie",
        people: ["Charlie"],
      });

      // Verify event_people was populated by triggers
      expect(getEventPeopleCount(db)).toBe(3); // Alice, Bob, Charlie

      // All checks should pass
      expect(countOrphanedRows(db)).toBe(0);
      expect(countStaleRows(db)).toBe(0);
      expect(countMissingRows(db)).toBe(0);
      expect(countMismatchedMetadata(db)).toBe(0);
    });

    test("handles events with null people field", () => {
      insertEvent({
        source: "test",
        type: "test:event",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Event",
        people: null,
      });

      expect(getEventPeopleCount(db)).toBe(0);
      expect(countOrphanedRows(db)).toBe(0);
      expect(countStaleRows(db)).toBe(0);
      expect(countMissingRows(db)).toBe(0);
      expect(countMismatchedMetadata(db)).toBe(0);
    });

    test("handles events with empty people array", () => {
      insertEvent({
        source: "test",
        type: "test:event",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Event",
        people: [],
      });

      expect(getEventPeopleCount(db)).toBe(0);
      expect(countMissingRows(db)).toBe(0);
    });
  });

  describe("orphaned row detection", () => {
    test("detects orphaned rows when event is deleted without trigger", () => {
      // Insert event with people (trigger populates event_people)
      const eventId = insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice", "Bob"],
      });

      expect(getEventPeopleCount(db)).toBe(2);

      // Disable triggers and delete event directly to simulate corruption
      db.exec("DROP TRIGGER events_people_ad");
      db.exec(`DELETE FROM events WHERE id = ${eventId}`);

      expect(getEventsCount(db)).toBe(0);
      expect(getEventPeopleCount(db)).toBe(2); // Orphaned rows remain

      expect(countOrphanedRows(db)).toBe(2);
    });

    test("detects multiple orphaned rows from different deleted events", () => {
      // Insert multiple events
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat 1",
        people: ["Alice"],
      });
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-02T12:00:00Z",
        title: "Chat 2",
        people: ["Bob", "Charlie"],
      });

      expect(getEventPeopleCount(db)).toBe(3);

      // Disable triggers and delete events
      db.exec("DROP TRIGGER events_people_ad");
      db.exec("DELETE FROM events");

      expect(countOrphanedRows(db)).toBe(3);
    });
  });

  describe("stale row detection", () => {
    test("detects stale rows when person is removed from event without trigger", () => {
      // Insert event with people
      const eventId = insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice", "Bob", "Charlie"],
      });

      expect(getEventPeopleCount(db)).toBe(3);

      // Disable triggers and update event to remove a person
      db.exec("DROP TRIGGER events_people_au_delete");
      db.exec("DROP TRIGGER events_people_au_insert");
      db.exec(`UPDATE events SET people = '["Alice", "Charlie"]' WHERE id = ${eventId}`);

      // Bob is now stale (in event_people but not in events.people)
      expect(countStaleRows(db)).toBe(1);
    });

    test("detects stale rows when people field is set to null", () => {
      const eventId = insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      expect(getEventPeopleCount(db)).toBe(1);

      // Disable triggers and set people to null
      db.exec("DROP TRIGGER events_people_au_delete");
      db.exec("DROP TRIGGER events_people_au_insert");
      db.exec(`UPDATE events SET people = NULL WHERE id = ${eventId}`);

      // Alice is now stale (event exists, but people is empty)
      expect(countStaleRows(db)).toBe(1);
      expect(countOrphanedRows(db)).toBe(0);
    });
  });

  describe("missing row detection", () => {
    test("detects missing rows when person is added without trigger", () => {
      // Insert event - trigger populates event_people
      const eventId = insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      expect(getEventPeopleCount(db)).toBe(1);

      // Disable triggers and add a person
      db.exec("DROP TRIGGER events_people_au_delete");
      db.exec("DROP TRIGGER events_people_au_insert");
      db.exec(`UPDATE events SET people = '["Alice", "Bob"]' WHERE id = ${eventId}`);

      // Bob is now missing from event_people
      expect(countMissingRows(db)).toBe(1);
    });

    test("ignores null and empty entries in people array", () => {
      // Disable insert trigger to simulate missing rows
      db.exec("DROP TRIGGER events_people_ai");

      db.exec(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
        VALUES ('discord', 'test-null-empty', 'test-account', 'message:dm', '2024-01-01T12:00:00Z', 'Chat', '["Alice", "", null]', '{}', 'verify-null-empty-thread')
      `);

      expect(getEventPeopleCount(db)).toBe(0);
      expect(countMissingRows(db)).toBe(1); // Only Alice should count
    });

    test("detects missing rows when event is inserted without trigger", () => {
      // Disable insert trigger
      db.exec("DROP TRIGGER events_people_ai");

      // Insert event directly (bypassing the helper since we want to test without trigger)
      db.exec(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
        VALUES ('discord', 'test-no-trigger', 'test-account', 'message:dm', '2024-01-01T12:00:00Z', 'Chat', '["Alice", "Bob"]', '{}', 'verify-no-trigger-thread')
      `);

      expect(getEventPeopleCount(db)).toBe(0);
      expect(countMissingRows(db)).toBe(2);
    });
  });

  describe("metadata mismatch detection", () => {
    test("detects source mismatch", () => {
      // Insert event with trigger
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      // Manually update event_people source to be wrong
      db.exec(`UPDATE event_people SET source = 'wrong_source' WHERE person = 'Alice'`);

      expect(countMismatchedMetadata(db)).toBe(1);
    });

    test("detects timestamp mismatch", () => {
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      // Manually update event_people timestamp to be wrong
      db.exec(`UPDATE event_people SET timestamp = '2024-06-01T12:00:00Z' WHERE person = 'Alice'`);

      expect(countMismatchedMetadata(db)).toBe(1);
    });

    test("detects timestamp null vs non-null mismatch", () => {
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      // Set event_people timestamp to null while event has a timestamp
      db.exec(`UPDATE event_people SET timestamp = NULL WHERE person = 'Alice'`);

      expect(countMismatchedMetadata(db)).toBe(1);
    });

    test("no mismatch when both timestamps are null", () => {
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: null,
        title: "Chat",
        people: ["Alice"],
      });

      // event_people.timestamp should be null from trigger
      const row = db.prepare("SELECT timestamp FROM event_people WHERE person = 'Alice'").get() as { timestamp: string | null };
      expect(row.timestamp).toBeNull();

      expect(countMismatchedMetadata(db)).toBe(0);
    });
  });

  describe("populateEventPeople rebuild", () => {
    test("rebuilds empty event_people from events", () => {
      // Disable triggers and insert events
      db.exec("DROP TRIGGER events_people_ai");

      db.exec(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
        VALUES ('discord', 'test-1', 'test-account', 'message:dm', '2024-01-01T12:00:00Z', 'Chat 1', '["Alice", "Bob"]', '{}', 'verify-rebuild-thread-1')
      `);
      db.exec(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
        VALUES ('discord', 'test-2', 'test-account', 'message:dm', '2024-01-02T12:00:00Z', 'Chat 2', '["Charlie"]', '{}', 'verify-rebuild-thread-2')
      `);

      expect(getEventPeopleCount(db)).toBe(0);
      expect(countMissingRows(db)).toBe(3);

      // Rebuild
      const count = populateEventPeople(db);

      expect(count).toBe(3);
      expect(getEventPeopleCount(db)).toBe(3);
      expect(countMissingRows(db)).toBe(0);
    });

    test("cleans up orphaned rows during rebuild", () => {
      // Insert event and let trigger populate
      const eventId = insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      // Disable trigger and delete event
      db.exec("DROP TRIGGER events_people_ad");
      db.exec(`DELETE FROM events WHERE id = ${eventId}`);

      expect(countOrphanedRows(db)).toBe(1);

      // Rebuild
      const count = populateEventPeople(db);

      expect(count).toBe(0);
      expect(countOrphanedRows(db)).toBe(0);
    });

    test("fixes stale rows during rebuild", () => {
      const eventId = insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice", "Bob"],
      });

      // Disable triggers and remove Bob from event
      db.exec("DROP TRIGGER events_people_au_delete");
      db.exec("DROP TRIGGER events_people_au_insert");
      db.exec(`UPDATE events SET people = '["Alice"]' WHERE id = ${eventId}`);

      expect(countStaleRows(db)).toBe(1);

      // Rebuild
      const count = populateEventPeople(db);

      expect(count).toBe(1); // Only Alice
      expect(countStaleRows(db)).toBe(0);
    });

    test("fixes metadata mismatches during rebuild", () => {
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      // Corrupt the metadata
      db.exec(`UPDATE event_people SET source = 'wrong', timestamp = '1999-01-01T00:00:00Z'`);

      expect(countMismatchedMetadata(db)).toBe(1);

      // Rebuild
      populateEventPeople(db);

      expect(countMismatchedMetadata(db)).toBe(0);

      // Verify correct values
      const row = db.prepare("SELECT source, timestamp FROM event_people WHERE person = 'Alice'").get() as {
        source: string;
        timestamp: string;
      };
      expect(row.source).toBe("discord");
      expect(row.timestamp).toBe("2024-01-01T12:00:00Z");
    });

    test("handles duplicate people in JSON array", () => {
      // Disable trigger
      db.exec("DROP TRIGGER events_people_ai");

      // Insert event with duplicate person in array
      db.exec(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
        VALUES ('discord', 'test-dup', 'test-account', 'message:dm', '2024-01-01T12:00:00Z', 'Chat', '["Alice", "Alice", "Bob"]', '{}', 'verify-dup-thread')
      `);

      // Rebuild should handle duplicates gracefully
      const count = populateEventPeople(db);

      expect(count).toBe(2); // Alice (deduplicated) + Bob
      expect(getEventPeopleCount(db)).toBe(2);
    });

    test("preserves indexes after rebuild", () => {
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      populateEventPeople(db);

      // Check indexes exist on event_people table
      // Note: SQLite keeps original index names after table rename, so they may have _new suffix
      const indexes = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'event_people'
      `).all() as Array<{ name: string }>;

      // Should have at least 3 user-defined indexes plus the autoindex for primary key
      const userIndexes = indexes.filter(i => !i.name.startsWith("sqlite_autoindex"));
      expect(userIndexes.length).toBeGreaterThanOrEqual(3);

      // Verify the indexes are usable by running queries that would use them
      // This query should use the person+source index
      const personQuery = db.prepare("SELECT * FROM event_people WHERE person = ? AND source = ?");
      expect(() => personQuery.all("Alice", "discord")).not.toThrow();

      // This query should use the person+timestamp index
      const tsQuery = db.prepare("SELECT * FROM event_people WHERE person = ? ORDER BY timestamp DESC");
      expect(() => tsQuery.all("Alice")).not.toThrow();
    });

    test("atomic rebuild - table exists throughout", () => {
      // Insert some data
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      // Verify table exists before
      const beforeCount = getEventPeopleCount(db);
      expect(beforeCount).toBe(1);

      // Rebuild
      populateEventPeople(db);

      // Verify table still exists with correct data
      const afterCount = getEventPeopleCount(db);
      expect(afterCount).toBe(1);

      // Verify we can query it normally
      const row = db.prepare("SELECT * FROM event_people WHERE person = 'Alice'").get();
      expect(row).toBeDefined();
    });

    test("cleanup of leftover temp table from interrupted rebuild", () => {
      // Simulate an interrupted rebuild by creating the temp table
      db.exec(`
        CREATE TABLE event_people_new (
          event_id INTEGER NOT NULL,
          person TEXT NOT NULL,
          source TEXT NOT NULL,
          timestamp TEXT,
          PRIMARY KEY (event_id, person)
        )
      `);

      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice"],
      });

      // Rebuild should clean up the leftover table and succeed
      const count = populateEventPeople(db);

      expect(count).toBe(1);

      // Temp table should not exist
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_people_new'
      `).all();
      expect(tables).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    test("handles large number of people in single event", () => {
      const people = Array.from({ length: 100 }, (_, i) => `Person${i}`);

      insertEvent({
        source: "discord",
        type: "message:group",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Large Group",
        people,
      });

      expect(getEventPeopleCount(db)).toBe(100);
      expect(countMissingRows(db)).toBe(0);
      expect(countOrphanedRows(db)).toBe(0);
    });

    test("handles special characters in person names", () => {
      // JSON with special characters: apostrophe, quotes, newline
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Chat",
        people: ["Alice O'Brien", 'Bob "The Builder"', "Charlie\nNewline"],
      });

      expect(getEventPeopleCount(db)).toBe(3);
      expect(countMissingRows(db)).toBe(0);
    });

    test("handles events across multiple sources", () => {
      insertEvent({
        source: "discord",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "Discord Chat",
        people: ["Alice"],
      });
      insertEvent({
        source: "facebook",
        type: "message:dm",
        timestamp: "2024-01-01T12:00:00Z",
        title: "FB Chat",
        people: ["Alice"],
      });

      expect(getEventPeopleCount(db)).toBe(2); // Same person, different sources

      const rows = db.prepare(`
        SELECT source FROM event_people WHERE person = 'Alice' ORDER BY source
      `).all() as Array<{ source: string }>;

      expect(rows.map(r => r.source)).toEqual(["discord", "facebook"]);
    });

    test("handles events with null timestamps", () => {
      insertEvent({
        source: "reddit",
        type: "vote",
        timestamp: null,
        title: "Upvote",
        people: ["User123"],
      });

      expect(getEventPeopleCount(db)).toBe(1);

      const row = db.prepare("SELECT timestamp FROM event_people WHERE person = 'User123'").get() as { timestamp: string | null };
      expect(row.timestamp).toBeNull();

      expect(countMismatchedMetadata(db)).toBe(0);
    });

    test("rebuild handles mixed null and non-null timestamps", () => {
      db.exec("DROP TRIGGER events_people_ai");

      db.exec(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
        VALUES ('discord', 'test-ts', 'test-account', 'message:dm', '2024-01-01T12:00:00Z', 'Chat', '["Alice"]', '{}', 'verify-ts-thread')
      `);
      db.exec(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data)
        VALUES ('reddit', 'test-null-ts', 'test-account', 'vote', NULL, 'Vote', '["Bob"]', '{}')
      `);

      expect(countMissingRows(db)).toBe(2);

      populateEventPeople(db);

      expect(countMissingRows(db)).toBe(0);

      const alice = db.prepare("SELECT timestamp FROM event_people WHERE person = 'Alice'").get() as { timestamp: string | null };
      const bob = db.prepare("SELECT timestamp FROM event_people WHERE person = 'Bob'").get() as { timestamp: string | null };

      expect(alice.timestamp).toBe("2024-01-01T12:00:00Z");
      expect(bob.timestamp).toBeNull();
    });
  });
});
