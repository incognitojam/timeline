import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { populateEventPeople } from "../db/queries";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { type VerificationResult, sampleMismatches, verifyEventPeople } from "./verify-event-people";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => {
  db.close();
});

let nextSourceId = 0;

function insertEvent(options: { source?: string; timestamp?: string | null; people: Array<string | null> | null }): number {
  nextSourceId += 1;
  const result = db
    .prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, people, raw_data)
      VALUES (?, ?, 'test-account', 'note', ?, ?, '{}')
    `)
    .run(
      options.source ?? "discord",
      `test-${nextSourceId}`,
      options.timestamp === undefined ? "2024-01-01T12:00:00Z" : options.timestamp,
      options.people ? JSON.stringify(options.people) : null,
    );
  return Number(result.lastInsertRowid);
}

function eventPeopleRows() {
  return db.prepare("SELECT person, source, timestamp FROM event_people ORDER BY person, source").all();
}

const IN_SYNC: VerificationResult = { orphanedRows: 0, staleRows: 0, missingRows: 0, mismatchedMetadata: 0 };

describe("verifyEventPeople", () => {
  test("finds no drift in the rows the triggers maintain", () => {
    insertEvent({ people: null });
    insertEvent({ people: [] });
    insertEvent({ source: "discord", people: ["Alice", 'Bob "The Builder"'] });
    insertEvent({ source: "facebook", people: ["Alice", "Charlie O'Brien\nJr"] });
    insertEvent({ source: "reddit", timestamp: null, people: ["Dana"] });

    expect(eventPeopleRows()).toEqual([
      { person: "Alice", source: "discord", timestamp: "2024-01-01T12:00:00Z" },
      { person: "Alice", source: "facebook", timestamp: "2024-01-01T12:00:00Z" },
      { person: 'Bob "The Builder"', source: "discord", timestamp: "2024-01-01T12:00:00Z" },
      { person: "Charlie O'Brien\nJr", source: "facebook", timestamp: "2024-01-01T12:00:00Z" },
      { person: "Dana", source: "reddit", timestamp: null },
    ]);
    expect(verifyEventPeople(db)).toEqual(IN_SYNC);
    expect(sampleMismatches(db, 5)).toEqual([]);
  });

  const DRIFT: Array<{
    name: string;
    corrupt: () => void;
    found: Partial<VerificationResult>;
    samples: Array<{ person: string; issue: string }>;
  }> = [
    {
      name: "an event deleted without its rows",
      corrupt: () => {
        const id = insertEvent({ people: ["Alice", "Bob"] });
        db.exec("DROP TRIGGER events_people_ad");
        db.prepare("DELETE FROM events WHERE id = ?").run(id);
      },
      found: { orphanedRows: 2 },
      samples: [
        { person: "Alice", issue: "orphaned (event deleted)" },
        { person: "Bob", issue: "orphaned (event deleted)" },
      ],
    },
    {
      name: "a person removed from the event",
      corrupt: () => {
        const id = insertEvent({ people: ["Alice", "Bob"] });
        db.exec("DROP TRIGGER events_people_au_delete; DROP TRIGGER events_people_au_insert");
        db.prepare(`UPDATE events SET people = '["Alice"]' WHERE id = ?`).run(id);
      },
      found: { staleRows: 1 },
      samples: [{ person: "Bob", issue: "stale (person removed from event)" }],
    },
    {
      name: "the event's people set to null",
      corrupt: () => {
        const id = insertEvent({ people: ["Alice"] });
        db.exec("DROP TRIGGER events_people_au_delete; DROP TRIGGER events_people_au_insert");
        db.prepare("UPDATE events SET people = NULL WHERE id = ?").run(id);
      },
      found: { staleRows: 1 },
      samples: [{ person: "Alice", issue: "stale (person removed from event)" }],
    },
    {
      name: "a person added to the event",
      corrupt: () => {
        const id = insertEvent({ people: ["Alice"] });
        db.exec("DROP TRIGGER events_people_au_delete; DROP TRIGGER events_people_au_insert");
        db.prepare(`UPDATE events SET people = '["Alice", "Bob"]' WHERE id = ?`).run(id);
      },
      found: { missingRows: 1 },
      samples: [{ person: "Bob", issue: "missing (not in event_people)" }],
    },
    {
      name: "an event inserted without its rows, ignoring empty and null people",
      corrupt: () => {
        db.exec("DROP TRIGGER events_people_ai");
        insertEvent({ people: ["Alice", "", null, "Bob"] });
      },
      found: { missingRows: 2 },
      samples: [
        { person: "Alice", issue: "missing (not in event_people)" },
        { person: "Bob", issue: "missing (not in event_people)" },
      ],
    },
    {
      name: "a row's source changed",
      corrupt: () => {
        insertEvent({ people: ["Alice"] });
        db.exec("UPDATE event_people SET source = 'wrong'");
      },
      found: { mismatchedMetadata: 1 },
      samples: [{ person: "Alice", issue: "metadata mismatch (source: wrong vs discord)" }],
    },
    {
      name: "a row's timestamp changed",
      corrupt: () => {
        insertEvent({ people: ["Alice"] });
        db.exec("UPDATE event_people SET timestamp = '2024-06-01T12:00:00Z'");
      },
      found: { mismatchedMetadata: 1 },
      samples: [{ person: "Alice", issue: "metadata mismatch (source: discord vs discord)" }],
    },
    {
      name: "a row's timestamp cleared",
      corrupt: () => {
        insertEvent({ people: ["Alice"] });
        db.exec("UPDATE event_people SET timestamp = NULL");
      },
      found: { mismatchedMetadata: 1 },
      samples: [{ person: "Alice", issue: "metadata mismatch (source: discord vs discord)" }],
    },
    {
      name: "a row's timestamp kept after the event's was cleared",
      corrupt: () => {
        const id = insertEvent({ people: ["Alice"] });
        db.exec("DROP TRIGGER events_people_au_delete; DROP TRIGGER events_people_au_insert");
        db.prepare("UPDATE events SET timestamp = NULL WHERE id = ?").run(id);
      },
      found: { mismatchedMetadata: 1 },
      samples: [{ person: "Alice", issue: "metadata mismatch (source: discord vs discord)" }],
    },
  ];

  test.each(DRIFT)("finds $name, and a rebuild repairs it", ({ corrupt, found, samples }) => {
    corrupt();

    expect(verifyEventPeople(db)).toEqual({ ...IN_SYNC, ...found });
    expect(sampleMismatches(db, 5).map(({ person, issue }) => ({ person, issue }))).toEqual(samples);

    populateEventPeople(db);

    expect(verifyEventPeople(db)).toEqual(IN_SYNC);
  });
});

describe("populateEventPeople", () => {
  test("keeps one row per person when the people array repeats a name", () => {
    db.exec("DROP TRIGGER events_people_ai");
    insertEvent({ people: ["Alice", "Alice", "Bob"] });

    expect(populateEventPeople(db)).toBe(2);
    expect(eventPeopleRows()).toEqual([
      { person: "Alice", source: "discord", timestamp: "2024-01-01T12:00:00Z" },
      { person: "Bob", source: "discord", timestamp: "2024-01-01T12:00:00Z" },
    ]);
  });

  test("copies null and non-null timestamps", () => {
    db.exec("DROP TRIGGER events_people_ai");
    insertEvent({ people: ["Alice"] });
    insertEvent({ source: "reddit", timestamp: null, people: ["Bob"] });

    populateEventPeople(db);

    expect(eventPeopleRows()).toEqual([
      { person: "Alice", source: "discord", timestamp: "2024-01-01T12:00:00Z" },
      { person: "Bob", source: "reddit", timestamp: null },
    ]);
  });

  test("recreates the same indexes and triggers that initDb creates", () => {
    const schemaObjects = () =>
      db
        .prepare(`
          SELECT type, name, replace(sql, '"', '') AS sql FROM sqlite_master
          WHERE (tbl_name = 'event_people' AND type = 'index') OR name LIKE 'events_people_%'
          ORDER BY name
        `)
        .all();
    const before = schemaObjects();
    insertEvent({ people: ["Alice"] });

    populateEventPeople(db);

    expect(schemaObjects()).toEqual(before);
  });

  test("drops a temp table left by an interrupted rebuild", () => {
    db.exec("CREATE TABLE event_people_new (event_id INTEGER NOT NULL, person TEXT NOT NULL)");
    insertEvent({ people: ["Alice"] });

    expect(populateEventPeople(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'event_people_new'").all()).toEqual([]);
  });
});
