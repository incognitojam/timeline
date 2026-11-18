import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../db/schema";
import { loadSqliteVec } from "../embeddings/sqlite-vec";
import { checkCompatibility } from "./sqlite-check-compat";

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
    const vectorBefore = readFileSync(vectors);
    const first = await checkCompatibility(path, vectors);
    const second = await checkCompatibility(path, vectors);
    expect(second).toEqual(first);
    expect(first.before.statisticsTables).toContain("sqlite_stat1");
    expect(first.before.integrity).toEqual(["ok"]);
    expect(first.afterInit.fts.events_fts?.integrity).toBe("ok");
    expect(JSON.stringify(first.vectors)).toContain("resultHash");
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(vectors)).toEqual(vectorBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
