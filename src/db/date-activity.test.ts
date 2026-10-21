import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  DATE_ACTIVITY_INDEX_SQL,
  DATE_ACTIVITY_SQL,
  listDateActivity,
  listDateActivityIndex,
} from "./date-activity";
import { wrapDatabase } from "./pool";
import { initDb } from "./schema";

describe("date activity summaries", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  test("range-scans the summary table instead of events", () => {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${DATE_ACTIVITY_SQL}`)
      .all("2026-05-01", "2026-05-31") as { detail: string }[];
    const details = plan.map((row) => row.detail).join("\n");

    expect(details).toContain(
      "SEARCH event_day_sources USING PRIMARY KEY (range_day>? AND range_day<?)",
    );
    expect(details).not.toContain("SCAN events");
  });

  test("builds the complete lightweight index from the summary table", async () => {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${DATE_ACTIVITY_INDEX_SQL}`).all() as {
      detail: string;
    }[];
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("SCAN event_day_sources");
    expect(details).not.toContain("SCAN events");

    const insert = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, raw_data
      ) VALUES (?, ?, 'test', 'test:event', ?, '{}')
    `);
    insert.run("alpha", "one", "2026-05-04T12:00:00Z");
    insert.run("beta", "two", "2026-05-04T13:00:00Z");
    insert.run("alpha", "three", "2016-02-03T12:00:00Z");

    expect(await listDateActivityIndex(wrapDatabase(db))).toEqual([
      { date: "2026-05-04", eventCount: 2 },
      { date: "2016-02-03", eventCount: 1 },
    ]);
  });

  test("excludes recall from counts, locations, sources, and active dates", async () => {
    const insert = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, location_name, raw_data
      ) VALUES (?, ?, 'test', 'test:event', ?, ?, '{}')
    `);
    insert.run("alpha", "one", "2026-05-04T12:00:00Z", null);
    insert.run("recall", "frame-one", "2026-05-04T13:00:00Z", "Example Place");
    insert.run("recall", "frame-two", "2026-05-05T13:00:00Z", null);

    const executor = wrapDatabase(db);
    expect(await listDateActivityIndex(executor)).toEqual([
      { date: "2026-05-04", eventCount: 1 },
    ]);
    expect(await listDateActivity(executor, "2026-05-04", "2026-05-05")).toEqual([
      {
        date: "2026-05-04",
        eventCount: 1,
        sources: ["alpha"],
        hasLocation: false,
      },
    ]);
  });

  test("preserves timestamp-range and UTC grouping semantics", async () => {
    const insert = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, raw_data
      ) VALUES ('offset', ?, 'test', 'test:event', ?, '{}')
    `);
    insert.run("utc", "2026-05-04T23:30:00Z");
    insert.run("positive-offset", "2026-05-05T00:30:00+01:00");

    expect(
      await listDateActivity(wrapDatabase(db), "2026-05-05", "2026-05-05"),
    ).toEqual([
      {
        date: "2026-05-04",
        eventCount: 1,
        sources: ["offset"],
        hasLocation: false,
      },
    ]);
    expect(
      await listDateActivity(wrapDatabase(db), "2026-05-04", "2026-05-04"),
    ).toEqual([
      {
        date: "2026-05-04",
        eventCount: 1,
        sources: ["offset"],
        hasLocation: false,
      },
    ]);
    expect(
      await listDateActivity(wrapDatabase(db), "2026-05-04", "2026-05-05"),
    ).toEqual([
      {
        date: "2026-05-04",
        eventCount: 2,
        sources: ["offset"],
        hasLocation: false,
      },
    ]);
  });

  test("maintains counts, sources, and locations across event writes", async () => {
    const insert = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, location_name, raw_data
      ) VALUES (?, ?, 'test', 'test:event', ?, ?, '{}')
    `);
    insert.run("alpha", "one", "2026-05-04T00:15:00Z", null);
    insert.run("alpha", "two", "2026-05-04T23:59:59.999Z", "Example Place");
    insert.run("beta", "three", "2026-05-04T12:00:00Z", null);
    insert.run("dateless", "four", null, "Example Place");

    const executor = wrapDatabase(db);
    expect(await listDateActivity(executor, "2026-05-04", "2026-05-04")).toEqual([
      {
        date: "2026-05-04",
        eventCount: 3,
        sources: ["alpha", "beta"],
        hasLocation: true,
      },
    ]);

    db.prepare(`
      UPDATE events
      SET timestamp = '2026-05-05T08:00:00Z', source = 'gamma', location_name = NULL
      WHERE source_id = 'two' AND source_account = 'test'
    `).run();

    expect(await listDateActivity(executor, "2026-05-04", "2026-05-05")).toEqual([
      {
        date: "2026-05-05",
        eventCount: 1,
        sources: ["gamma"],
        hasLocation: false,
      },
      {
        date: "2026-05-04",
        eventCount: 2,
        sources: ["alpha", "beta"],
        hasLocation: false,
      },
    ]);

    db.prepare(
      "DELETE FROM events WHERE source_id IN ('one', 'three') AND source_account = 'test'",
    ).run();
    db.prepare(
      "UPDATE events SET timestamp = NULL WHERE source_id = 'two' AND source_account = 'test'",
    ).run();

    expect(await listDateActivity(executor, "2026-05-04", "2026-05-05")).toEqual([]);
  });

  test("balances implicit deletes from INSERT OR REPLACE", async () => {
    const replace = db.prepare(`
      INSERT OR REPLACE INTO events (
        source, source_id, source_account, type, timestamp, raw_data
      ) VALUES ('replace', 'same-id', 'test', 'test:event', ?, '{}')
    `);
    const executor = wrapDatabase(db);

    replace.run("2026-05-04T12:00:00Z");
    replace.run("2026-05-05T12:00:00Z");
    replace.run("2026-05-05T12:00:00Z");

    expect(await listDateActivity(executor, "2026-05-04", "2026-05-05")).toEqual([
      {
        date: "2026-05-05",
        eventCount: 1,
        sources: ["replace"],
        hasLocation: false,
      },
    ]);
  });

  test("excludes legacy bare dates after an update", async () => {
    db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, raw_data
      ) VALUES (
        'legacy-date', 'bare-after-update', 'test', 'test:event',
        '2026-05-04T12:00:00Z', '{}'
      )
    `).run();
    db.prepare(`
      UPDATE events SET timestamp = '2026-05-04'
      WHERE source = 'legacy-date' AND source_id = 'bare-after-update'
    `).run();

    expect(
      await listDateActivity(wrapDatabase(db), "2026-05-04", "2026-05-04"),
    ).toEqual([]);
  });

  test("backfills an empty summary when opening an existing database", async () => {
    db.exec(`
      DROP TRIGGER event_day_sources_ai;
      DROP TRIGGER event_day_sources_ad;
      DROP TRIGGER event_day_sources_au;
      DELETE FROM event_day_sources;
    `);
    db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp, location_name, raw_data
      ) VALUES (
        'legacy', 'existing', 'test', 'test:event',
        '2026-05-04T12:00:00Z', 'Example Place', '{}'
      )
    `).run();

    expect(db.prepare("SELECT 1 FROM event_day_sources").get()).toBeNull();

    initDb(db);

    expect(
      await listDateActivity(wrapDatabase(db), "2026-05-04", "2026-05-04"),
    ).toEqual([
      {
        date: "2026-05-04",
        eventCount: 1,
        sources: ["legacy"],
        hasLocation: true,
      },
    ]);
  });
});
