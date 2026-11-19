import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyConnectionPragmas } from "../db/connection";
import { populateEventPeople } from "../db/queries";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import {
  type VerificationResult,
  assertSqliteVersion,
  isClean,
  issueCount,
  rebuildAndVerify,
  sampleMismatches,
  verifyEventPeople,
} from "./verify-event-people";

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

  describe("interrupted part-way", () => {
    // Everything a rebuild replaces: the rows, the schema objects and the counts.
    const snapshot = () => ({
      rows: db.prepare("SELECT * FROM event_people ORDER BY event_id, person").all(),
      schema: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('event_people', 'events', 'identities') ORDER BY name").all(),
      counts: db.prepare("SELECT platform_id, event_count FROM identities ORDER BY platform_id").all(),
    });

    test("rolls back to the old table when a statement fails", () => {
      db.prepare("INSERT INTO identities (platform, platform_id) VALUES ('discord', 'bob')").run();
      const id = insertEvent({ people: ["discord:alice", "discord:bob", "discord:carol"], conversationId: "discord:group" });
      db.prepare("INSERT INTO event_people (event_id, person, source, timestamp, is_sender) VALUES (?, 'discord:bob', 'discord', '2024-01-01T12:00:00Z', 0)").run(id);
      // The identity refresh is the rebuild's last statement.
      db.exec("CREATE TRIGGER fail_refresh BEFORE UPDATE OF event_count ON identities BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
      const before = snapshot();

      expect(() => populateEventPeople(db)).toThrow("interrupted");

      expect(snapshot()).toEqual(before);
    });

    test("reports the error when SQLite has already rolled back by itself", () => {
      db.prepare("INSERT INTO identities (platform, platform_id) VALUES ('discord', 'x')").run();
      db.exec("CREATE TRIGGER fail_refresh BEFORE UPDATE OF event_count ON identities BEGIN SELECT RAISE(ROLLBACK, 'rolled back by SQLite'); END");
      const before = snapshot();

      expect(() => populateEventPeople(db)).toThrow("rolled back by SQLite");

      expect(snapshot()).toEqual(before);
    });

    test("rolls back to the old table when the database is full", () => {
      db.exec("DROP TRIGGER events_people_ai");
      for (let i = 0; i < 200; i++) insertEvent({ people: [`Person ${i}`, "Owner"] });
      const pages = (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
      db.exec(`PRAGMA max_page_count = ${pages}`);
      const before = snapshot();

      expect(() => populateEventPeople(db)).toThrow(/full/);

      expect(snapshot()).toEqual(before);
    });
  });
});

describe("sender-only rule for group messages", () => {
  function rowsFor(eventId: number) {
    return db.prepare("SELECT person, is_sender FROM event_people WHERE event_id = ? ORDER BY person").all(eventId);
  }

  // The verifier compares a stored person with its JSON value, so it can only
  // confirm string values: a stored '5' is not equal to the JSON number 5.
  test.each<{ people: string; indexed: Array<{ person: string; is_sender: number }>; verifiable: boolean }>([
    { people: '"Alice"', indexed: [{ person: "Alice", is_sender: 0 }], verifiable: true },
    { people: '{"friend":"Bob"}', indexed: [{ person: "Bob", is_sender: 0 }], verifiable: true },
    { people: "5", indexed: [{ person: "5", is_sender: 0 }], verifiable: false },
    { people: "true", indexed: [{ person: "1", is_sender: 0 }], verifiable: false },
  ])("indexes a people value that isn't an array, $people, as a non-sender", ({ people, indexed, verifiable }) => {
    const id = Number(db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, people, raw_data, conversation_id)
      VALUES ('discord', 'scalar', 'alex', 'message:group', '2024-01-01T12:00:00Z', ?, '{}', 'discord:group')
    `).run(people).lastInsertRowid);

    expect(rowsFor(id)).toEqual(indexed);
    if (verifiable) expect(verifyEventPeople(db)).toEqual(IN_SYNC);
    populateEventPeople(db);
    expect(rowsFor(id)).toEqual(indexed);
  });

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

describe("rebuildAndVerify", () => {
  beforeEach(() => {
    insertEvent({ people: ["Alice", "Bob", "Carol"], conversationId: "discord:group" });
    // A member row from before the sender rule.
    db.exec("INSERT INTO event_people (event_id, person, source, timestamp, is_sender) SELECT id, 'Bob', source, timestamp, 0 FROM events");
  });
  const rows = () => db.prepare("SELECT person FROM event_people ORDER BY person").all();

  test("verifies a committed rebuild", () => {
    const outcome = rebuildAndVerify(db);

    expect(outcome).toMatchObject({ kind: "committed", rows: 1 });
    expect(outcome.kind === "committed" && isClean(outcome.after)).toBe(true);
  });

  test("reports a failed rebuild as rolled back, with the old table intact", () => {
    db.prepare("INSERT INTO identities (platform, platform_id) VALUES ('discord', 'x')").run();
    db.exec("CREATE TRIGGER fail_refresh BEFORE UPDATE OF event_count ON identities BEGIN SELECT RAISE(ABORT, 'interrupted'); END");

    expect(rebuildAndVerify(db).kind).toBe("rolled-back");
    expect(rows()).toEqual([{ person: "Alice" }, { person: "Bob" }]);
  });

  test("reports verification that fails after a commit apart from a rollback", () => {
    const outcome = rebuildAndVerify(db, () => {
      throw new Error("verification interrupted");
    });

    expect(outcome).toMatchObject({ kind: "committed-unverified", rows: 1 });
    expect(rows()).toEqual([{ person: "Alice" }]);
  });

  test("reports issues found after a commit", () => {
    const outcome = rebuildAndVerify(db, (db) => ({ ...verifyEventPeople(db), staleRows: 1 }));

    expect(outcome.kind === "committed" && isClean(outcome.after)).toBe(false);
  });
});

describe("on a database file", () => {
  let dir: string;
  let file: Database;
  const path = () => join(dir, "timeline.db");
  const size = (suffix = "") => statSync(`${path()}${suffix}`).size;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "event-people-"));
    file = new Database(path());
    applyConnectionPragmas(file);
    initDb(file);
    const members = Array.from({ length: 60 }, (_, i) => `discord:member-${i}`);
    const insert = file.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
      VALUES ('discord', ?, 'alex', 'message:group', '2024-01-01T12:00:00Z', 'Group', ?, '{}', 'discord:group')
    `);
    file.exec("BEGIN");
    for (let i = 0; i < 300; i++) insert.run(`m${i}`, JSON.stringify(members));
    // The members' rows, as the previous rule wrote them: far more than the rebuild keeps.
    file.exec(`INSERT INTO event_people (event_id, person, source, timestamp, is_sender)
      SELECT e.id, p.value, e.source, e.timestamp, 0 FROM events e, json_each(e.people) p WHERE p.key > 0`);
    file.exec("COMMIT");
    file.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  });

  afterEach(() => {
    file.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("rebuilds in the old table's pages without growing the file", () => {
    const before = size();

    expect(populateEventPeople(file)).toBe(300);
    file.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    expect(size()).toBeLessThanOrEqual(before);
  });

  test("drops the old table without writing it to the WAL, whatever secure_delete defaulted to", () => {
    const oldTable = (file.prepare(`
      SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name = 'event_people')
    `).get() as { bytes: number }).bytes;
    file.exec("PRAGMA secure_delete = ON");

    populateEventPeople(file);

    expect(size("-wal")).toBeLessThan(oldTable / 4);
  });

  describe("the script", () => {
    const script = resolve(import.meta.dir, "verify-event-people.ts");
    const run = (args: string[], dbPath = path()) => {
      const result = Bun.spawnSync([process.execPath, script, ...args], {
        env: { ...process.env, TIMELINE_DB_PATH: dbPath },
      });
      return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
    };

    test("names the database it opened and its event count", () => {
      const { exitCode, output } = run([]);
      expect(exitCode).toBe(0);
      expect(output).toContain(`Database: ${path()}`);
      expect(output).toContain("Events:   300");
      expect(output).toContain("REBUILD NEEDED");
    });

    // The library choice (TIMELINE_SQLITE_LIBRARY_PATH) takes effect only on
    // macOS, so these runs use Bun's default library and can't test loading one.

    test("refuses a missing database without creating it", () => {
      const missing = join(dir, "missing.db");
      const { exitCode, output } = run(["--force-rebuild"], missing);
      expect(exitCode).toBe(1);
      expect(output).toContain(`No database at ${missing}`);
      expect(existsSync(missing)).toBe(false);
    });

    test("refuses to rebuild a database with no events", () => {
      file.exec("DELETE FROM events");
      const { exitCode, output } = run(["--force-rebuild"]);
      expect(exitCode).toBe(1);
      expect(output).toContain("has no events");
    });

    test("exits 2 when the rebuild rolls back", () => {
      file.prepare("INSERT INTO identities (platform, platform_id) VALUES ('discord', 'x')").run();
      file.exec("CREATE TRIGGER fail_refresh BEFORE UPDATE OF event_count ON identities BEGIN SELECT RAISE(ABORT, 'interrupted'); END");

      const { exitCode, output } = run(["--force-rebuild"]);
      expect(exitCode).toBe(2);
      expect(output).toContain("REBUILD FAILED AND ROLLED BACK");
    });

    test("exits 3 when the rebuild commits but verifying it finds issues", () => {
      file.prepare("INSERT INTO identities (platform, platform_id) VALUES ('discord', 'x')").run();
      // The rebuild's last statement leaves a row for an event that doesn't exist.
      file.exec(`CREATE TRIGGER leave_orphan AFTER UPDATE OF event_count ON identities BEGIN
        INSERT OR IGNORE INTO event_people (event_id, person, source, timestamp, is_sender) VALUES (999999, 'discord:x', 'discord', NULL, 0);
      END`);

      const { exitCode, output } = run(["--force-rebuild"]);
      expect(output).toContain("REBUILD COMMITTED, BUT VERIFYING IT FOUND ISSUES");
      expect(exitCode).toBe(3);
    });

    test("exits 0 when the rebuild commits and verifies clean", () => {
      const { exitCode, output } = run(["--force-rebuild"]);
      expect(exitCode).toBe(0);
      expect(output).toContain("REBUILD COMMITTED AND VERIFIED");
    });
  });
});

describe("assertSqliteVersion", () => {
  test.each(["3.38.0", "3.38.5", "3.54.0", "4.0.0"])("accepts %s", (version) => {
    expect(() => assertSqliteVersion(version)).not.toThrow();
  });

  test.each(["3.37.2", "3.9.9", "2.99.0"])("refuses %s", (version) => {
    expect(() => assertSqliteVersion(version)).toThrow("older than 3.38.0");
  });
});
