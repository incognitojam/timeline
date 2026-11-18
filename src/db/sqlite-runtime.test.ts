import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSqliteVec } from "../embeddings/sqlite-vec";
import { openReadonlyDbAtPath } from "./readonly";
import { initDb } from "./schema";
import { SQLITE_PIN } from "./sqlite-pin";
import { assertSqlitePin } from "./sqlite-runtime";

describe.skipIf(process.platform === "darwin")("pinned SQLite (macOS waits for PR 4: bundled runtime selection)", () => {
  test("Linux runtime matches Bun's pinned SQLite, with an actionable mismatch", () => {
    using db = new Database(":memory:");
    assertSqlitePin(db);
    expect(() => assertSqlitePin(db, { ...SQLITE_PIN, version: "deliberately-wrong" } as unknown as typeof SQLITE_PIN)).toThrow("bun run sqlite:pin");
  });

  test("last WAL close removes sidecars and read-only open works without them", () => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-wal-"));
    const path = join(directory, "timeline.db");
    try {
      const writer = new Database(path);
      try {
        writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('kept')");
        expect(existsSync(`${path}-wal`)).toBe(true);
      } finally { writer.close(); }
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
      using reader = openReadonlyDbAtPath(path);
      expect(reader.query("SELECT value FROM probe").get()).toEqual({ value: "kept" });
      expect(() => reader.exec("DELETE FROM probe")).toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("schema, stemmed FTS and REPLACE retain consistent indexes and derived counts", () => {
    using db = new Database(":memory:");
    initDb(db);
    const insert = db.query("INSERT OR REPLACE INTO events(source, source_id, source_account, type, timestamp, title, content, raw_data) VALUES ('manual', 'pin-test', '', 'note', '2026-01-01T12:00:00Z', ?, ?, '{}')");
    insert.run("running", "synthetic document");
    expect(db.query("SELECT rowid FROM events_fts_stemmed WHERE events_fts_stemmed MATCH 'run'").all()).toHaveLength(1);
    db.exec("UPDATE events SET title='walking' WHERE source_id='pin-test'");
    insert.run("swimming", "replacement document");
    for (const table of ["events_fts", "events_fts_stemmed"]) {
      db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
      expect(db.query(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'walking'`).all()).toHaveLength(0);
      expect(db.query(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'swimming'`).all()).toHaveLength(1);
    }
    expect(db.query("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 1 });
    expect(db.query("SELECT count(*) n FROM events").get()).toEqual({ n: 1 });
    expect(db.query("SELECT sum(event_count) n FROM event_day_sources").get()).toEqual({ n: 1 });
  });

  test("sqlite-vec loads and executes kNN without environment guards", () => {
    using db = new Database(":memory:");
    loadSqliteVec(db);
    db.exec("CREATE VIRTUAL TABLE vectors USING vec0(embedding float[3])");
    const insert = db.query("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)");
    insert.run(1, new Float32Array([1, 0, 0]));
    insert.run(2, new Float32Array([0, 1, 0]));
    expect(db.query("SELECT rowid FROM vectors WHERE embedding MATCH ? AND k=1 ORDER BY distance").all(new Float32Array([1, 0, 0]))).toEqual([{ rowid: 1 }]);
  });

  test("Bun's UDL-capable parser accepts UPDATE LIMIT", () => {
    using db = new Database(":memory:");
    db.exec("CREATE TABLE probe(value INTEGER) STRICT; INSERT INTO probe VALUES (1), (2); UPDATE probe SET value=3 LIMIT 1");
    expect(db.query("SELECT count(*) n FROM probe WHERE value=3").get()).toEqual({ n: 1 });
  });
});
