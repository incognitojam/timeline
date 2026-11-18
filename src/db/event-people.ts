import { Database } from "./sqlite";
import { createEventPeopleTriggers, dropEventPeopleTriggers, eventPeopleRowsSql } from "./schema";

/**
 * Rebuild the event_people index table from events.people, then refresh
 * identities.event_count from it.
 *
 * One IMMEDIATE transaction: writers wait until it commits, readers keep seeing
 * the old table until then, and an error or interruption rolls everything back.
 * The old table is dropped first so the new rows reuse its freed pages rather
 * than growing the file; indexes are built after the rows, in one sort each.
 */
export function populateEventPeople(db: Database): number {
  // With secure_delete on, dropping the old table would write every freed page to the WAL.
  db.exec("PRAGMA secure_delete = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    dropEventPeopleTriggers(db);
    db.exec("DROP TABLE IF EXISTS event_people");
    db.exec(`
      CREATE TABLE event_people (
        event_id INTEGER NOT NULL,
        person TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp TEXT,
        is_sender INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (event_id, person)
      )
    `);
    db.exec(`
      INSERT OR IGNORE INTO event_people (event_id, person, source, timestamp, is_sender)
      ${eventPeopleRowsSql("events e")}
    `);
    db.exec(`CREATE INDEX idx_event_people_person_ts ON event_people(person, source, timestamp DESC)`);
    db.exec(`CREATE INDEX idx_event_people_person_only_ts ON event_people(person, timestamp DESC)`);
    db.exec(`CREATE INDEX idx_event_people_sender_ts ON event_people(person, is_sender, timestamp DESC)`);
    createEventPeopleTriggers(db);

    db.exec(`
      UPDATE identities
      SET event_count = COALESCE(
        (SELECT COUNT(*) FROM event_people ep WHERE ep.person = (identities.platform || ':' || identities.platform_id)),
        0
      )
    `);

    // Counted inside the transaction, so a failure here rolls back too.
    const countRow = db.prepare("SELECT COUNT(*) as count FROM event_people").get() as { count: number };

    db.exec("COMMIT");
    return countRow.count;
  } catch (err) {
    // SQLite rolls back by itself on some errors (I/O, a full disk); report the error, not the ROLLBACK.
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
