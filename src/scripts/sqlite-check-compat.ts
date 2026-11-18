import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sqliteFingerprint } from "../db/sqlite-runtime";

function quote(identifier: string): string { return `"${identifier.replaceAll('"', '""')}"`; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function hashRows(rows: Iterable<unknown>): string {
  const digest = createHash("sha256");
  for (const row of rows) digest.update(JSON.stringify(row)).update("\n");
  return digest.digest("hex");
}
function tables(db: Database) { return db.query<{ name: string; sql: string | null }, []>("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY name").all(); }
function checkIntegrity(db: Database) {
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all().map(row => row.integrity_check);
  if (JSON.stringify(integrity) !== '["ok"]') throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
  return integrity;
}
function structure(db: Database) {
  return {
    integrity: checkIntegrity(db),
    schemaHash: hash(db.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all()),
    rowCounts: Object.fromEntries(tables(db).map(({ name }) => [name, db.query(`SELECT count(*) count FROM ${quote(name)}`).get()])),
    statisticsTables: tables(db).map(row => row.name).filter(name => name.startsWith("sqlite_stat")),
  };
}
interface QueryPlanRow { id: number; parent: number; detail: string }
export function normalizeQueryPlan(rows: QueryPlanRow[]) {
  const ids = new Map(rows.map((row, index) => [row.id, index]));
  return rows.map((row, index) => ({ id: index, parent: ids.get(row.parent) ?? null, detail: row.detail }));
}
function timeline(db: Database) {
  const fts = Object.fromEntries(["events_fts", "events_fts_stemmed"].map(table => {
    db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
    return [table, {
      integrity: "ok",
      matches: Object.fromEntries(["coffee", "meeting", "run"].map(term => [term, hashRows(db.query(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid`).iterate(term))])),
    }];
  }));
  const queries = [
    "SELECT id FROM events WHERE timestamp >= '2026-01-01' AND timestamp < '2026-02-01' ORDER BY timestamp, id LIMIT 100",
    "SELECT id FROM events WHERE source='discord' ORDER BY timestamp DESC, id DESC LIMIT 100",
    "SELECT id FROM events WHERE id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH 'coffee') ORDER BY timestamp DESC, id DESC LIMIT 100",
  ];
  return {
    ...structure(db), fts,
    jsonHash: hashRows(db.query("SELECT id, json_extract(raw_data, '$.type') value FROM events WHERE json_valid(raw_data) ORDER BY id").iterate()),
    queries: queries.map(sql => ({ resultHash: hash(db.query(sql).all()), plan: normalizeQueryPlan(db.query<QueryPlanRow, []>(`EXPLAIN QUERY PLAN ${sql}`).all()) })),
  };
}

export async function checkCompatibility(database: string, embeddings?: string, workDirectory?: string) {
  const root = resolve(import.meta.dir, "../..");
  if (!workDirectory && Bun.spawnSync(["git", "check-ignore", "-q", ".scratch/"], { cwd: root }).exitCode !== 0) {
    throw new Error("Ignore .scratch/ in .git/info/exclude before running sqlite:check-compat");
  }
  const { mkdir } = await import("node:fs/promises");
  const workspace = workDirectory ?? join(root, ".scratch");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "sqlite-compat-"));
  const inputIntegrity: Record<string, string[]> = {};
  const { loadSqliteVec } = await import("../embeddings/sqlite-vec");
  function copy(input: string, name: string, vector = false): Database {
    // SQLite copies a consistent snapshot including WAL; never migrate the supplied file.
    using original = new Database(resolve(input), { readonly: true, strict: true });
    if (vector) loadSqliteVec(original);
    // VACUUM rebuilds ordinary indexes: inspect the original pages first.
    inputIntegrity[vector ? "embeddings" : "timeline"] = checkIntegrity(original);
    const output = join(directory, name);
    original.query("VACUUM INTO ?").run(output);
    const db = new Database(output, { strict: true });
    if (vector) loadSqliteVec(db);
    return db;
  }
  try {
    let runtime: ReturnType<typeof sqliteFingerprint>;
    let before: ReturnType<typeof timeline>;
    {
      using snapshot = copy(database, "timeline.db");
      runtime = sqliteFingerprint(snapshot);
      before = timeline(snapshot);
    }
    using db = new Database(join(directory, "timeline.db"), { strict: true });
    const { initDb } = await import("../db/schema");
    initDb(db);
    const afterInit = timeline(db);
    // Exercise the real trigger path in a rollback-only transaction on the disposable copy.
    db.exec("BEGIN");
    let triggerProbe: unknown;
    try {
      const insert = db.query("INSERT OR REPLACE INTO events(source, source_id, source_account, type, timestamp, title, raw_data) VALUES ('manual', ?, '', 'note', '2026-01-01T12:00:00Z', ?, '{}')");
      const id = `sqlite-compat-${crypto.randomUUID()}`;
      insert.run(id, "synthetic running");
      insert.run(id, "synthetic swimming");
      for (const table of ["events_fts", "events_fts_stemmed"]) db.exec(`INSERT INTO ${table}(${table}, rank) VALUES('integrity-check', 1)`);
      triggerProbe = structure(db);
    } finally { db.exec("ROLLBACK"); }
    let vectors: unknown = { status: "not supplied; pass --embeddings <copy> to check vectors" };
    if (embeddings) {
      using vectorDb = copy(embeddings, "embeddings.db", true);
      vectors = {
        ...structure(vectorDb), version: vectorDb.query("SELECT vec_version() version").get(),
        knn: tables(vectorDb).filter(row => /USING\s+vec0\b/i.test(row.sql ?? "")).map(({ name }) => {
          const vector = vectorDb.query<{ embedding: Uint8Array }, []>(`SELECT embedding FROM ${quote(name)} ORDER BY rowid LIMIT 1`).get();
          return { table: name, resultHash: vector ? hash(vectorDb.query(`SELECT rowid, distance FROM ${quote(name)} WHERE embedding MATCH ? AND k=10 ORDER BY distance`).all(vector.embedding)) : null };
        }),
      };
    }
    return { ...runtime, inputIntegrity, before, afterInit, triggerProbe, vectors };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2).filter(arg => arg !== "--"), options: { library: { type: "string" }, db: { type: "string" }, embeddings: { type: "string" } }, strict: true });
  if (!values.library || !values.db) throw new Error("Usage: bun run sqlite:check-compat --library <dylib|builtin> --db <copy> [--embeddings <copy>]");
  if (process.platform === "darwin") {
    if (values.library === "builtin" || !Database.setCustomSQLite(resolve(values.library))) throw new Error("macOS requires an explicit loadable SQLite library");
  } else if (process.platform !== "linux" || values.library !== "builtin") {
    throw new Error("Linux cannot select a SQLite library; use --library builtin to check Bun's embedded build");
  }
  // No environment setup is invoked: only this diagnostic selects the requested library.
  const output = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try { output(JSON.stringify(await checkCompatibility(values.db, values.embeddings), null, 2)); }
  finally { console.log = output; }
}
