import { expect, test } from "bun:test";
import { Database } from "../../db/sqlite";
import { explain } from "./analyze";
import { statements } from "./sql";

test("distinguishes full walks, selective lookups, aliases, CTEs and automatic indexes", () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT, timestamp TEXT); CREATE INDEX by_time ON events(timestamp)");
  expect(explain(db, "SELECT * FROM events WHERE title = ?").findings.map(f => f.kind)).toEqual(["table-scan"]);
  expect(explain(db, "SELECT timestamp FROM events ORDER BY timestamp").findings.map(f => f.kind)).toEqual(["index-scan"]);
  expect(explain(db, "SELECT * FROM events WHERE timestamp = ?").findings).toEqual([]);
  expect(explain(db, 'SELECT * FROM events AS "e" WHERE e.title = ?').findings[0]?.table).toBe("events");
  expect(explain(db, "WITH recent AS MATERIALIZED (SELECT * FROM events WHERE title = ?) SELECT * FROM recent").findings.map(f => f.table)).toEqual(["events"]);
  const join = explain(db, "SELECT a.id FROM events a CROSS JOIN events b ON a.title = b.title");
  expect(join.findings.some(f => f.kind === "automatic-index")).toBe(true);
  expect(explain(db, "UPDATE events SET title = ? WHERE timestamp = ?").findings).toEqual([]);
  expect(explain(db, "DELETE FROM events WHERE title = ?").findings[0]?.kind).toBe("table-scan");
});

test("FTS MATCH and rowid searches are not unbounded virtual scans", () => {
  using db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE events_fts USING fts5(title)");
  expect(explain(db, "SELECT * FROM events_fts WHERE events_fts MATCH ?").findings).toEqual([]);
  expect(explain(db, "SELECT * FROM events_fts WHERE rowid = ?").findings).toEqual([]);
  expect(explain(db, "SELECT * FROM events_fts").findings[0]?.kind).toBe("virtual-scan");
});

test("batch normalization preserves literals, operators, bindings and trigger bodies", () => {
  const batch = `-- start\nSELECT 'a ;  b', 1.2e-3 >= ?1, :name || 'x'; /* skip */
    CREATE TRIGGER t AFTER INSERT ON events BEGIN UPDATE events SET title = CASE WHEN title IS NULL THEN ';' ELSE title END; DELETE FROM events WHERE id < 0; END;
    SELECT 2;`;
  const split = statements(batch);
  expect(split).toHaveLength(3);
  using db = new Database(":memory:");
  db.exec("CREATE TABLE events(id INTEGER, title TEXT)");
  expect(db.prepare(split[0]!).get(0, "hello")).toBeDefined();
  db.exec(split[1]!);
  expect(db.prepare(split[2]!).get()).toEqual({ "2": 2 });
});

test("records actual app preparation, preserves bindings and closes, and excludes fixture SQL", async () => {
  const { recordQueryPlans } = await import("./recorder");
  const { initAppStateDb, getTrackImageUrls, setSpotifyResource } = await import("../../db/app-state");
  const finish = recordQueryPlans();
  const db = new Database(":memory:");
  try {
    initAppStateDb(db);
    setSpotifyResource(db, "spotify:track:synthetic", "track", "Synthetic", "https://example.com/cover.png");
    expect(getTrackImageUrls(db, ["spotify:track:synthetic"]).get("spotify:track:synthetic")).toBe("https://example.com/cover.png");
    db.query("SELECT 'fixture-only'").get();
    expect(() => db.query("SELECT * FROM absent_table")).toThrow();
    db.close();
  } finally {
    const result = finish();
    expect(result.records.some(row => row.sql.includes("SELECT uri, image_url"))).toBe(true);
    expect(result.records.some(row => row.sql.includes("fixture-only") || row.sql.includes("absent_table"))).toBe(false);
    expect(result.records.every(row => row.database === "app-state")).toBe(true);
  }
});

test("CTE aliases and VALUES rows do not hide scans of underlying tables", () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT)");
  expect(explain(db, "WITH lookups(x) AS (VALUES (1), (2)) SELECT * FROM lookups l").findings).toEqual([]);
  expect(explain(db, "WITH grouped AS MATERIALIZED (SELECT * FROM events) SELECT * FROM grouped g").findings.map(f => f.table)).toEqual(["events"]);
  expect(explain(db, "SELECT * FROM main.events e").findings.length).toBeGreaterThan(0);
  expect(() => explain(db, "SELECT * FROM a_missing_runtime_table")).toThrow();
  expect(db.prepare(statements("SELECT x'1234', 0xff, 1.2e-3, 2 << 1")[0]!).get()).toBeDefined();
});

test("the final checker rejects a newly exercised unindexed query and accepts a keyed lookup", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "query-plan-gate-"));
  const path = join(directory, "recording.json");
  const run = (sql: string) => {
    writeFileSync(path, JSON.stringify({ records: [{ database: "timeline", sql, origin: "synthetic gate regression" }], collectionErrors: [], fullSuite: false }));
    return Bun.spawnSync([process.execPath, "--no-env-file", "src/testing/query-plans/check.ts", path], { env: process.env, stdout: "pipe", stderr: "pipe" });
  };
  const rejected = run("SELECT id FROM events WHERE title = 'synthetic gate regression'");
  expect(rejected.exitCode).toBe(1);
  expect(new TextDecoder().decode(rejected.stderr)).toContain("Add an index or rewrite the query");
  expect(run("SELECT id FROM events WHERE id = ?").exitCode).toBe(0);
});

test("bare SEARCH for an unindexed aggregate is a table scan", () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE events(title TEXT)");
  const plan = explain(db, "SELECT MAX(title) FROM events");
  expect(plan.details).toEqual(["SEARCH events"]);
  expect(plan.findings).toEqual([{ table: "events", kind: "table-scan", detail: "SEARCH events" }]);
});
