import { Database } from "../db/sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../db/schema";
import { loadSqliteVec } from "../embeddings/sqlite-vec";
import { checkCompatibility, normalizeQueryPlan } from "./sqlite-check-compat";

test.skipIf(process.platform === "darwin")("compat fingerprint migrates disposable copies and reports stats and vector results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-compat-test-"));
  try {
    const path = join(dir, "timeline.db");
    const vectors = join(dir, "embeddings.db");
    {
      using db = new Database(path);
      initDb(db);
      db.exec("INSERT INTO events(source, source_id, type, timestamp, title, raw_data) VALUES ('manual', 'probe', 'note', '2026-01-01T12:00:00Z', 'coffee running', '{\"type\":\"note\"}'); ANALYZE");
    }
    {
      using db = new Database(vectors);
      loadSqliteVec(db);
      db.exec("CREATE VIRTUAL TABLE probe USING vec0(embedding float[3]); INSERT INTO probe(rowid, embedding) VALUES (1, '[1,0,0]'), (2, '[0,1,0]')");
    }
    const before = readFileSync(path);
    // initDb persists WAL mode; the last writer's close removes its sidecars.
    expect(before[18]).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["embeddings.db", "timeline.db"]);
    const vectorBefore = readFileSync(vectors);
    const first = await checkCompatibility(path, vectors, dir);
    const second = await checkCompatibility(path, vectors, dir);
    expect(second).toEqual(first);
    expect(first.before.statisticsTables).toContain("sqlite_stat1");
    expect(first.before.integrity).toEqual(["ok"]);
    expect(first.inputIntegrity).toEqual({ timeline: ["ok"], embeddings: ["ok"] });
    // Read-only SQLite may create WAL/SHM sidecars. It must not change the inputs
    // or leave any disposable working database in the caller's directory.
    expect(readdirSync(dir).every(name => /^(timeline|embeddings)\.db(?:-wal|-shm)?$/.test(name))).toBe(true);
    expect(first.afterInit.fts.events_fts?.integrity).toBe("ok");
    expect(JSON.stringify(first.vectors)).toContain("resultHash");
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(vectors)).toEqual(vectorBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("query plans preserve tree shape while discarding unstable numeric fields", () => {
  const a = [{ id: 9, parent: 0, notused: 54, detail: "SCAN events" }, { id: 20, parent: 9, notused: 151, detail: "USE TEMP B-TREE" }];
  const b = [{ id: 3, parent: 0, notused: 91, detail: "SCAN events" }, { id: 5, parent: 3, notused: 156, detail: "USE TEMP B-TREE" }];
  expect(normalizeQueryPlan(a)).toEqual(normalizeQueryPlan(b));
  expect(normalizeQueryPlan(a)).toEqual([{ id: 0, parent: null, detail: "SCAN events" }, { id: 1, parent: 0, detail: "USE TEMP B-TREE" }]);
});
