import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { populateEventPeople } from "../db/queries";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { type VerificationResult, issueCount, sampleMismatches, verifyEventPeople } from "./verify-event-people";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => {
  db.close();
});

let nextSourceId = 0;

function insertEvent(options: {
  source?: string;
  timestamp?: string | null;
  people: Array<string | null> | null;
  conversationId?: string;
  rawData?: string;
}): number {
  nextSourceId += 1;
  const result = db
    .prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, people, raw_data, conversation_id)
      VALUES (?, ?, 'test-account', ?, ?, ?, ?, ?)
    `)
    .run(
      options.source ?? "discord",
      `test-${nextSourceId}`,
      options.conversationId ? "message:group" : "note",
      options.timestamp === undefined ? "2024-01-01T12:00:00Z" : options.timestamp,
      options.people ? JSON.stringify(options.people) : null,
      options.rawData ?? "{}",
      options.conversationId ?? null,
    );
  return Number(result.lastInsertRowid);
}

function eventPeopleRows() {
  return db.prepare("SELECT person, source, timestamp FROM event_people ORDER BY person, source").all();
}

const IN_SYNC: VerificationResult = {
  orphanedRows: 0,
  staleRows: 0,
  missingRows: 0,
  mismatchedMetadata: 0,
  rowsBeforeSenderRule: 0,
};

const GROUP = ["Alice", "Bob", "Carol"];

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

  test("lets an event whose people array repeats its sender be updated", () => {
    const id = insertEvent({ people: ["Alice", "Bob", "Alice"] });

    db.prepare("UPDATE events SET content = 'edited' WHERE id = ?").run(id);

    expect(db.prepare("SELECT person, is_sender FROM event_people ORDER BY person").all()).toEqual([
      { person: "Alice", is_sender: 1 },
      { person: "Bob", is_sender: 0 },
    ]);
    expect(verifyEventPeople(db)).toEqual(IN_SYNC);
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

  test("drops the (person, source) index older databases carry", () => {
    db.exec("CREATE INDEX idx_event_people_person ON event_people(person, source)");

    populateEventPeople(db);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_event_people_person'").all()).toEqual([]);
  });

  test("drops a temp table left by an interrupted rebuild", () => {
    db.exec("CREATE TABLE event_people_new (event_id INTEGER NOT NULL, person TEXT NOT NULL)");
    insertEvent({ people: ["Alice"] });

    expect(populateEventPeople(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'event_people_new'").all()).toEqual([]);
  });
});

describe("sender-only rule for group messages", () => {
  function rowsFor(eventId: number) {
    return db.prepare("SELECT person, is_sender FROM event_people WHERE event_id = ? ORDER BY person").all(eventId);
  }

  test.each<{ name: string; people: Array<string | null>; indexed: string[] }>([
    { name: "a group", people: ["Alice", "Bob", "Carol"], indexed: ["Alice"] },
    { name: "a pair with a null entry", people: ["Alice", "Bob", null], indexed: ["Alice", "Bob"] },
    { name: "a pair after an empty sender", people: ["", "Bob", "Carol"], indexed: ["Bob", "Carol"] },
    { name: "a pair repeating its sender", people: ["Alice", "Bob", "Alice"], indexed: ["Alice", "Bob"] },
    { name: "a group with an empty entry", people: ["Alice", "", "Bob", "Carol"], indexed: ["Alice"] },
  ])("counts distinct, non-empty people to tell $name", ({ people, indexed }) => {
    const id = insertEvent({ people, conversationId: "discord:conversation" });
    const persons = () => (rowsFor(id) as Array<{ person: string }>).map((row) => row.person);

    expect(persons()).toEqual(indexed);
    expect(verifyEventPeople(db)).toEqual(IN_SYNC);

    populateEventPeople(db);
    expect(persons()).toEqual(indexed);
  });

  const RENAMED = ["facebook:name:Old Name", "facebook:name:New Name", "facebook:name:Owner"];
  const exportParticipants = (participants: unknown) => JSON.stringify({ conversation: { participants } });

  test.each<{ name: string; rawData: string; indexed: string[] }>([
    { name: "two listed participants", rawData: exportParticipants(["New Name", "Owner"]), indexed: RENAMED },
    { name: "one listed participant", rawData: exportParticipants(["Owner"]), indexed: RENAMED },
    { name: "three listed participants", rawData: exportParticipants(["Old Name", "New Name", "Owner"]), indexed: [RENAMED[0]] },
    { name: "an empty participant list", rawData: exportParticipants([]), indexed: [RENAMED[0]] },
    { name: "a participant list that isn't an array", rawData: exportParticipants("New Name, Owner"), indexed: [RENAMED[0]] },
    { name: "no participant list", rawData: "{}", indexed: [RENAMED[0]] },
    { name: "malformed raw_data", rawData: "not json", indexed: [RENAMED[0]] },
  ])("reads a three-name conversation with $name from the export", ({ rawData, indexed }) => {
    const id = insertEvent({ source: "facebook", people: RENAMED, conversationId: "facebook:inbox/chat", rawData });
    const persons = () => (rowsFor(id) as Array<{ person: string }>).map((row) => row.person).sort();

    expect(persons()).toEqual([...indexed].sort());
    expect(verifyEventPeople(db)).toEqual(IN_SYNC);

    populateEventPeople(db);
    expect(persons()).toEqual([...indexed].sort());
  });

  test.each<{ name: string; people: string[]; indexed: Array<{ person: string; is_sender: number }> }>([
    { name: "a pair", people: ["Alice", "Bob", "Alice"], indexed: [{ person: "Alice", is_sender: 1 }, { person: "Bob", is_sender: 0 }] },
    { name: "a group", people: ["Alice", "Bob", "Carol", "Alice"], indexed: [{ person: "Alice", is_sender: 1 }] },
  ])("lets $name in a conversation that repeats its sender be updated", ({ people, indexed }) => {
    const id = insertEvent({ people, conversationId: "discord:conversation" });

    db.prepare("UPDATE events SET content = 'edited' WHERE id = ?").run(id);

    expect(rowsFor(id)).toEqual(indexed);
    expect(verifyEventPeople(db)).toEqual(IN_SYNC);
  });

  test("indexes only the sender of a group message, and everyone elsewhere", () => {
    const group = insertEvent({ people: GROUP, conversationId: "discord:group" });
    const dm = insertEvent({ people: ["Alice", "Bob"], conversationId: "discord:dm" });
    const calendar = insertEvent({ source: "google-calendar", people: GROUP });

    expect(rowsFor(group)).toEqual([{ person: "Alice", is_sender: 1 }]);
    expect(rowsFor(dm)).toEqual([{ person: "Alice", is_sender: 1 }, { person: "Bob", is_sender: 0 }]);
    expect(rowsFor(calendar).map((row) => (row as { person: string }).person)).toEqual(GROUP);
    expect(verifyEventPeople(db)).toEqual(IN_SYNC);

    // The rebuild applies the same rule.
    populateEventPeople(db);
    expect(rowsFor(group)).toEqual([{ person: "Alice", is_sender: 1 }]);
    expect(verifyEventPeople(db)).toEqual(IN_SYNC);
  });

  describe("rows indexed before the rule", () => {
    let oldGroup: number;

    function identityCounts() {
      return db.prepare("SELECT platform_id AS person, event_count FROM identities ORDER BY platform_id").all();
    }

    function countedRows() {
      return db.prepare(`
        SELECT i.platform_id AS person, (SELECT COUNT(*) FROM event_people ep WHERE ep.person = 'discord:' || i.platform_id) AS event_count
        FROM identities i ORDER BY i.platform_id
      `).all();
    }

    beforeEach(() => {
      for (const name of ["alice", "bob", "carol"]) {
        db.prepare("INSERT INTO identities (platform, platform_id) VALUES ('discord', ?)").run(name);
      }
      oldGroup = insertEvent({ people: ["discord:alice", "discord:bob", "discord:carol"], conversationId: "discord:group" });
      // The members' rows, as the previous triggers wrote them.
      db.prepare(`
        INSERT INTO event_people (event_id, person, source, timestamp, is_sender)
        VALUES (?1, 'discord:bob', 'discord', '2024-01-01T12:00:00Z', 0), (?1, 'discord:carol', 'discord', '2024-01-01T12:00:00Z', 0)
      `).run(oldGroup);
    });

    test("are not drift, so --rebuild leaves the table alone", () => {
      const result = verifyEventPeople(db);
      expect(result.rowsBeforeSenderRule).toBe(2);
      expect(issueCount(result)).toBe(0);
    });

    test("are reported as predating the rule, not as drift", () => {
      expect(identityCounts()).toEqual([
        { person: "alice", event_count: 1 },
        { person: "bob", event_count: 1 },
        { person: "carol", event_count: 1 },
      ]);
      expect(verifyEventPeople(db)).toEqual({ ...IN_SYNC, rowsBeforeSenderRule: 2 });
      expect(sampleMismatches(db, 5)).toEqual([]);
    });

    test("stay untouched when the schema is initialised again", () => {
      initDb(db);
      expect(rowsFor(oldGroup)).toHaveLength(3);
    });

    test("sit beside new group messages, which index only their sender", () => {
      insertEvent({ people: ["discord:bob", "discord:alice", "discord:carol"], conversationId: "discord:group" });

      expect(identityCounts()).toEqual([
        { person: "alice", event_count: 1 },
        { person: "bob", event_count: 2 },
        { person: "carol", event_count: 1 },
      ]);
      expect(identityCounts()).toEqual(countedRows());
      expect(verifyEventPeople(db)).toEqual({ ...IN_SYNC, rowsBeforeSenderRule: 2 });
    });

    test("are dropped when their event is updated, and the counts follow", () => {
      db.prepare("UPDATE events SET content = 'edited' WHERE id = ?").run(oldGroup);

      expect(rowsFor(oldGroup)).toEqual([{ person: "discord:alice", is_sender: 1 }]);
      expect(identityCounts()).toEqual([
        { person: "alice", event_count: 1 },
        { person: "bob", event_count: 0 },
        { person: "carol", event_count: 0 },
      ]);
      expect(verifyEventPeople(db)).toEqual(IN_SYNC);
    });

    test("are deleted with their event, and the counts follow", () => {
      db.prepare("DELETE FROM events WHERE id = ?").run(oldGroup);

      expect(rowsFor(oldGroup)).toEqual([]);
      expect(identityCounts()).toEqual(countedRows());
      expect(identityCounts().every((row) => (row as { event_count: number }).event_count === 0)).toBe(true);
      expect(verifyEventPeople(db)).toEqual(IN_SYNC);
    });

    test("are dropped by a rebuild, which refreshes the counts", () => {
      populateEventPeople(db);

      expect(rowsFor(oldGroup)).toEqual([{ person: "discord:alice", is_sender: 1 }]);
      expect(identityCounts()).toEqual(countedRows());
      expect(verifyEventPeople(db)).toEqual(IN_SYNC);
    });
  });
});
