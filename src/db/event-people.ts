import { Database } from "bun:sqlite";
import { createEventPeopleTriggers, dropEventPeopleTriggers } from "./schema";

/**
 * Populate the event_people index table from existing events.
 * This denormalizes the JSON people arrays for fast lookups.
 *
 * Uses atomic table swap pattern:
 * 1. Create new table with data and indexes
 * 2. Drop old table and rename new table
 *
 * This ensures readers see either the old or new data, never an empty table.
 * Writers are blocked during the transaction, but readers continue uninterrupted.
 */
export function populateEventPeople(db: Database): number {
  // Clean up any leftover temp table from interrupted previous run
  db.exec("DROP TABLE IF EXISTS event_people_new");

  db.exec("BEGIN IMMEDIATE");
  try {
    dropEventPeopleTriggers(db);

    // Create new table with same schema
    db.exec(`
      CREATE TABLE event_people_new (
        event_id INTEGER NOT NULL,
        person TEXT NOT NULL,
        source TEXT NOT NULL,
        timestamp TEXT,
        is_sender INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (event_id, person)
      )
    `);

    // Populate from events.people JSON arrays
    // Use INSERT OR IGNORE to handle duplicate people in the same event's JSON array
    // is_sender = 1 for people[0] (the sender/originator)
    db.exec(`
      INSERT OR IGNORE INTO event_people_new (event_id, person, source, timestamp, is_sender)
      SELECT e.id, p.value, e.source, e.timestamp, CASE WHEN p.key = 0 THEN 1 ELSE 0 END
      FROM events e, json_each(e.people) p
      WHERE e.people IS NOT NULL
        AND p.value IS NOT NULL
        AND p.value != ''
    `);

    // Atomic swap: drop old table, build indexes on new table with final names, then rename.
    // Index names are freed by dropping the old table.
    // Triggers on events table reference event_people by name - they'll work with renamed table.
    db.exec("DROP TABLE IF EXISTS event_people");
    db.exec(`CREATE INDEX idx_event_people_person ON event_people_new(person, source)`);
    db.exec(`CREATE INDEX idx_event_people_person_ts ON event_people_new(person, source, timestamp DESC)`);
    db.exec(`CREATE INDEX idx_event_people_person_only_ts ON event_people_new(person, timestamp DESC)`);
    db.exec(`CREATE INDEX idx_event_people_sender_ts ON event_people_new(person, is_sender, timestamp DESC)`);
    db.exec("ALTER TABLE event_people_new RENAME TO event_people");
    createEventPeopleTriggers(db);

    // Refresh identities.event_count from rebuilt event_people
    db.exec(`
      UPDATE identities
      SET event_count = COALESCE(
        (SELECT COUNT(*) FROM event_people ep WHERE ep.person = (identities.platform || ':' || identities.platform_id)),
        0
      )
    `);

    // Return count of rows while still in the transaction (so failures can rollback)
    const countRow = db.prepare("SELECT COUNT(*) as count FROM event_people").get() as { count: number };

    db.exec("COMMIT");
    return countRow.count;
  } catch (err) {
    db.exec("ROLLBACK");
    // Clean up partial temp table if it exists
    try {
      db.exec("DROP TABLE IF EXISTS event_people_new");
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
