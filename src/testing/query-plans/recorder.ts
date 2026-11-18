import { resolve } from "node:path";
import { Database } from "../../db/sqlite";
import { DbPool } from "../../db/pool";

export type RecordedDatabase = "timeline" | "app-state";
export interface RecordedStatement {
  sql: string;
  origin: string;
  database: RecordedDatabase;
}
export interface QueryRecording {
  records: RecordedStatement[];
  collectionErrors: string[];
  fullSuite?: boolean;
}

/** Installed only by bun:test's preload; production imports no instrumentation. */
export function recordQueryPlans() {
  const root = resolve(import.meta.dir, "../../..");
  const original = {
    prepare: Database.prototype.prepare,
    query: Database.prototype.query,
    run: Database.prototype.run,
    exec: Database.prototype.exec,
    close: Database.prototype.close,
  };
  const poolOriginal = { create: DbPool.create, query: DbPool.prototype.query, get: DbPool.prototype.get, run: DbPool.prototype.run };
  const poolDatabases = new WeakMap<DbPool, RecordedDatabase | null>();
  const pending = new Map<Database, Map<string, string>>();
  const records = new Map<string, RecordedStatement>();
  const collectionErrors: string[] = [];
  let active = true;
  let nested = false;

  function origin(): string | undefined {
    const frames = new Error().stack?.split("\n").filter(line => line.includes("/src/") && !line.includes("/testing/") && !line.includes("/db/sqlite.ts")) ?? [];
    const frame = frames[0];
    if (!frame || /\.test\.[cm]?[jt]sx?:/.test(frame)) return;
    const testFrame = frames.findIndex(line => /\.test\.[cm]?[jt]sx?:/.test(line));
    return frames.slice(0, testFrame < 0 ? 4 : Math.min(4, testFrame)).map(line => line.trim().replaceAll(`${root}/`, "")).join("\n");
  }

  function classify(db: Database): RecordedDatabase | null {
    const names = original.query.call(db, "SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[];
    const tables = new Set(names.map(row => row.name));
    const timeline = tables.has("events");
    const appState = tables.has("sync_log");
    if (timeline !== appState) return timeline ? "timeline" : "app-state";
    return null;
  }

  function add(database: RecordedDatabase, sql: string, origin: string) {
    records.set(`${database}\0${sql}`, { database, sql, origin });
  }

  // Instrumentation failures are reported by the final check, never thrown into
  // application code (especially close(), which must release its connection).
  function observe(operation: () => void) {
    try { operation(); } catch (error) { collectionErrors.push(String(error)); }
  }

  function collect(db: Database) {
    const entries = pending.get(db);
    if (!entries) return;
    pending.delete(db);
    nested = true;
    try {
      const database = classify(db);
      if (database) for (const [sql, origin] of entries) add(database, sql, origin);
    } finally { nested = false; }
  }

  for (const method of ["prepare", "query", "run", "exec"] as const) {
    const invoke = original[method] as (this: Database, ...args: unknown[]) => unknown;
    Object.defineProperty(Database.prototype, method, { configurable: true, writable: true, value: function(this: Database, ...args: unknown[]) {
      if (!active || nested) return invoke.apply(this, args);
      nested = true;
      let value: unknown;
      try { value = invoke.apply(this, args); } finally { nested = false; }
      observe(() => {
        const sql = args[0];
        if (typeof sql !== "string") return;
        let entries = pending.get(this);
        if (!entries) { entries = new Map(); pending.set(this, entries); }
        if (!entries.has(sql)) {
          const caller = origin();
          if (caller) entries.set(sql, caller);
        }
      });
      return value;
    } });
  }
  Database.prototype.close = function(...args) {
    observe(() => collect(this));
    return original.close.apply(this, args);
  };

  DbPool.create = async function(...args) {
    const pool = await poolOriginal.create.apply(this, args);
    observe(() => {
      // Pool workers have already opened this path successfully. A separate
      // readonly connection identifies its schema without accessing private fields.
      nested = true;
      try {
        const probe = new Database(args[0], { readonly: true });
        try { poolDatabases.set(pool, classify(probe)); }
        finally { original.close.call(probe); }
      } finally { nested = false; }
    });
    return pool;
  };
  // query dispatches worker method "all"; get and run are the other public SQL entrypoints.
  for (const method of ["query", "get", "run"] as const) {
    const invoke = poolOriginal[method] as (this: DbPool, sql: string, ...params: unknown[]) => Promise<unknown>;
    Object.defineProperty(DbPool.prototype, method, { configurable: true, writable: true, value: function(this: DbPool, sql: string, ...params: unknown[]) {
      let caller: string | undefined;
      if (active) observe(() => { caller = origin(); });
      return invoke.call(this, sql, ...params).then(value => {
        if (active) observe(() => {
          const database = poolDatabases.get(this);
          if (database && caller) add(database, sql, caller);
        });
        return value;
      });
    } });
  }

  return (): QueryRecording => {
    active = false;
    for (const db of pending.keys()) observe(() => collect(db));
    Object.assign(Database.prototype, original);
    DbPool.create = poolOriginal.create;
    for (const method of ["query", "get", "run"] as const) Object.defineProperty(DbPool.prototype, method, { configurable: true, writable: true, value: poolOriginal[method] });
    return { records: [...records.values()], collectionErrors };
  };
}
