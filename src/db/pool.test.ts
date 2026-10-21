/**
 * DbPool unit tests.
 * Tests pool lifecycle, query execution, error handling, and wrapDatabase adapter.
 *
 * Uses a single shared pool for read tests. Workers are warmed up in beforeAll
 * to eagerly load the SQLite schema — without this, lazy schema loading in Bun
 * worker threads races and can fail with "no such table".
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getTimelineDbPath } from "./paths";
import {
  DbPool,
  waitForQueryAbort,
  withoutQueryAbortSignal,
  withQueryAbortSignal,
  wrapDatabase,
} from "./pool";
import { initDb } from "./schema";

// Use the test database set up by test/setup.ts
const dbPath = getTimelineDbPath();
const LONG_RUNNING_QUERY = `
  WITH RECURSIVE counter(value) AS (
    VALUES(0)
    UNION ALL
    SELECT value + 1 FROM counter WHERE value < 1000000000
  )
  SELECT SUM(value) AS total FROM counter
`;

// Seed test data once before all tests.
{
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  initDb(db);
  db.prepare(`
    INSERT OR IGNORE INTO events (source, source_id, source_account, type, timestamp, title, content, people, tags, raw_data, conversation_id)
    VALUES
      ('test', 'pool-1', 'alice', 'message:dm', '2024-01-15T10:00:00Z', 'Test Chat', 'Hello world', '["discord:alice"]', '["test"]', '{}', 'pool-test-chat'),
      ('test', 'pool-2', 'alice', 'message:dm', '2024-01-15T10:01:00Z', 'Test Chat', 'Hi there', '["discord:bob"]', '["test"]', '{}', 'pool-test-chat'),
      ('test', 'pool-3', 'alice', 'listen:track', '2024-01-15T11:00:00Z', 'Song A', 'Artist A - Album A', null, '["music"]', '{}', null)
  `).run();
  db.close();
}

// Shared pool for all read tests — created once, closed at the end.
let pool: DbPool;

beforeAll(async () => {
  pool = await DbPool.create(dbPath, { workers: 2 });
  // Warm up each worker with a query that loads the events table schema.
  // Without this, the first query to each worker triggers lazy schema loading,
  // which can race under Bun's worker threading and fail with "no such table".
  await pool.query("SELECT COUNT(*) FROM events");
  await pool.query("SELECT COUNT(*) FROM events");
});

afterAll(() => {
  pool?.close();
});

describe("DbPool", () => {
  test("create() initializes workers and resolves", () => {
    expect(pool.size).toBe(2);
  });

  test("query() returns rows", async () => {
    const rows = await pool.query<{ source: string; title: string }>(
      "SELECT source, title FROM events WHERE source = ? LIMIT 3",
      "test"
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("source");
    expect(rows[0]).toHaveProperty("title");
  });

  test("get() returns single row or null", async () => {
    const row = await pool.get<{ title: string }>(
      "SELECT title FROM events WHERE source_id = ?",
      "pool-1"
    );
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Test Chat");

    const missing = await pool.get<{ title: string }>(
      "SELECT title FROM events WHERE source_id = ?",
      "nonexistent-999"
    );
    expect(missing).toBeNull();
  });

  test("concurrent queries execute without blocking each other", async () => {
    const results = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM events WHERE source = ?", "test"),
      pool.get("SELECT title FROM events WHERE source_id = ?", "pool-1"),
      pool.query("SELECT DISTINCT type FROM events WHERE source = ?", "test"),
      pool.get("SELECT source FROM events WHERE source_id = ?", "pool-3"),
    ]);

    expect(results).toHaveLength(4);
    expect(Array.isArray(results[0])).toBe(true);
    expect(results[1]).not.toBeNull();
    expect(Array.isArray(results[2])).toBe(true);
    expect(results[3]).not.toBeNull();
  });

  test("invalid SQL returns error without crashing worker", async () => {
    await expect(pool.query("SELECT * FROM nonexistent_table_xyz")).rejects.toThrow();

    // Worker should still work after error
    const rows = await pool.query<{ count: number }>("SELECT COUNT(*) as count FROM events");
    expect(rows[0].count).toBeGreaterThanOrEqual(0);
  });
});

describe("wrapDatabase", () => {
  test("query() returns rows", async () => {
    const db = new Database(dbPath, { readonly: true });
    const executor = wrapDatabase(db);

    const rows = await executor.query<{ source: string }>(
      "SELECT DISTINCT source FROM events WHERE source = ?",
      "test"
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].source).toBe("test");
    db.close();
  });

  test("get() returns single row or null", async () => {
    const db = new Database(dbPath, { readonly: true });
    const executor = wrapDatabase(db);

    const row = await executor.get<{ title: string }>(
      "SELECT title FROM events WHERE source_id = ?",
      "pool-1"
    );
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Test Chat");

    const missing = await executor.get<{ title: string }>(
      "SELECT title FROM events WHERE source_id = ?",
      "nonexistent-999"
    );
    expect(missing).toBeNull();
    db.close();
  });

  test("works identically to DbPool for read queries", async () => {
    const db = new Database(dbPath, { readonly: true });
    const wrapped = wrapDatabase(db);

    const sql = "SELECT source, title, type FROM events WHERE source = ? ORDER BY source_id LIMIT 3";
    const wrappedResult = await wrapped.query(sql, "test");
    const poolResult = await pool.query(sql, "test");

    expect(wrappedResult).toEqual(poolResult);
    db.close();
  });
});

describe("DbPool lifecycle", () => {
  test("rejects invalid worker counts at creation", async () => {
    await expect(DbPool.create(dbPath, { workers: 0 })).rejects.toThrow(
      "worker count must be a positive integer"
    );
    await expect(DbPool.create(dbPath, { workers: -1 })).rejects.toThrow(
      "worker count must be a positive integer"
    );
    await expect(DbPool.create(dbPath, { workers: 1.5 })).rejects.toThrow(
      "worker count must be a positive integer"
    );
  });

  test("rejects non-cloneable bindings without poisoning the worker", async () => {
    const error = await pool.get("SELECT ? AS value", () => {}).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toEqual(new TypeError("Database query parameters must be SQLite bindings"));
    expect(pool.getStats()).toEqual({ size: 2, pending: 0, queued: 0, workers: [0, 0] });
    await expect(pool.get<{ value: number }>("SELECT 1 AS value")).resolves.toEqual({ value: 1 });
  });

  test("rolls back bookkeeping when postMessage throws", async () => {
    const internals = pool as unknown as { workers: Array<{ worker: Worker }> };
    const worker = internals.workers[0].worker;
    try {
      Object.defineProperty(worker, "postMessage", {
        configurable: true,
        value: () => {
          throw new DOMException("The object can not be cloned", "DataCloneError");
        },
      });

      await expect(pool.get("SELECT 1 AS value")).rejects.toHaveProperty("name", "DataCloneError");
      expect(pool.getStats()).toEqual({ size: 2, pending: 0, queued: 0, workers: [0, 0] });

      delete (worker as unknown as { postMessage?: Worker["postMessage"] }).postMessage;
      await expect(pool.get<{ value: number }>("SELECT 1 AS value")).resolves.toEqual({ value: 1 });
    } finally {
      delete (worker as unknown as { postMessage?: Worker["postMessage"] }).postMessage;
    }
  });

  test("replaces a failed worker after rejecting its assigned query", async () => {
    const p = await DbPool.create(dbPath, { workers: 1 });
    const internals = p as unknown as {
      workers: Array<{ worker: Worker; available: boolean }>;
    };
    const failedWorker = internals.workers[0].worker;
    try {
      const query = p.get(LONG_RUNNING_QUERY);
      failedWorker.terminate();

      await expect(query).rejects.toThrow("Database worker exited unexpectedly");
      for (let attempt = 0; attempt < 100; attempt++) {
        if (internals.workers[0].available && internals.workers[0].worker !== failedWorker) break;
        await Bun.sleep(5);
      }

      expect(internals.workers[0].available).toBe(true);
      expect(internals.workers[0].worker).not.toBe(failedWorker);
      await expect(p.get<{ value: number }>("SELECT 1 AS value")).resolves.toEqual({ value: 1 });
    } finally {
      p.close();
    }
  });

  test("retains a fatal worker replacement error", async () => {
    const replacementTestDb = join(tmpdir(), `timeline-replacement-test-${Date.now()}.db`);
    new Database(replacementTestDb).close();
    const p = await DbPool.create(replacementTestDb, { workers: 1 });
    const internals = p as unknown as { workers: Array<{ worker: Worker }> };
    unlinkSync(replacementTestDb);
    internals.workers[0].worker.terminate();

    let failure: unknown;
    for (let attempt = 0; attempt < 100; attempt++) {
      failure = await p.get("SELECT 1").then(
        () => null,
        (reason: unknown) => reason,
      );
      if (failure instanceof Error && failure.message.startsWith("Failed to replace database worker")) {
        break;
      }
      await Bun.sleep(5);
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected worker replacement failure");
    expect(failure.message).toContain("Failed to replace database worker");
  });

  test("close() cleans up workers", async () => {
    // Use a separate database so terminated workers don't interfere with
    // the shared pool's workers on dbPath.
    const closeTestDb = join(tmpdir(), `timeline-close-test-${Date.now()}.db`);
    new Database(closeTestDb).close();

    const p = await DbPool.create(closeTestDb, { workers: 1 });
    p.close();
    await expect(p.query("SELECT 1")).rejects.toThrow("Pool is closed");
  });

  test("closeAndWait() waits for worker runtimes to close", async () => {
    const closeTestDb = join(tmpdir(), `timeline-close-wait-test-${Date.now()}.db`);
    new Database(closeTestDb).close();

    const p = await DbPool.create(closeTestDb, { workers: 1 });
    await p.closeAndWait();
    await expect(p.query("SELECT 1")).rejects.toThrow("Pool is closed");
  });
});

describe("DbPool request cancellation", () => {
  test("does not dispatch work for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      withQueryAbortSignal(controller.signal, () => pool.query("SELECT 1")),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(pool.getStats().pending).toBe(0);
  });

  test("rejects an in-flight query without marking its worker idle", async () => {
    const cancellationPool = await DbPool.create(dbPath, { workers: 1 });
    const controller = new AbortController();
    try {
      const query = withQueryAbortSignal(controller.signal, () =>
        cancellationPool.get(`
          WITH RECURSIVE counter(value) AS (
            VALUES(0)
            UNION ALL
            SELECT value + 1 FROM counter WHERE value < 100000000
          )
          SELECT SUM(value) AS total FROM counter
        `)
      );

      await Bun.sleep(10);
      controller.abort();

      await expect(query).rejects.toHaveProperty("name", "AbortError");
      expect(cancellationPool.getStats()).toEqual({
        size: 1,
        pending: 1,
        queued: 0,
        workers: [1],
      });
    } finally {
      cancellationPool.close();
    }
  });

  test("removes an aborted query from the pool-owned queue", async () => {
    const cancellationPool = await DbPool.create(dbPath, { workers: 1 });
    const controller = new AbortController();
    try {
      const running = cancellationPool.get("SELECT 1 AS value");
      const queued = withQueryAbortSignal(controller.signal, () =>
        cancellationPool.get<{ value: number }>("SELECT 2 AS value")
      );

      expect(cancellationPool.getStats()).toEqual({
        size: 1,
        pending: 2,
        queued: 1,
        workers: [1],
      });

      controller.abort();

      await expect(queued).rejects.toHaveProperty("name", "AbortError");
      expect(cancellationPool.getStats()).toEqual({
        size: 1,
        pending: 1,
        queued: 0,
        workers: [1],
      });

      await running;
      expect(cancellationPool.getStats()).toEqual({
        size: 1,
        pending: 0,
        queued: 0,
        workers: [0],
      });
    } finally {
      cancellationPool.close();
    }
  });

  test("keeps concurrent request abort contexts isolated", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const active = new AbortController();

    const [abortedResult, activeResult] = await Promise.allSettled([
      withQueryAbortSignal(aborted.signal, () => pool.query("SELECT 1 AS value")),
      withQueryAbortSignal(active.signal, () => pool.get<{ value: number }>("SELECT 1 AS value")),
    ]);

    expect(abortedResult.status).toBe("rejected");
    expect(activeResult).toEqual({ status: "fulfilled", value: { value: 1 } });
  });

  test("detaches shared work while cancelling an aborted waiter", async () => {
    const controller = new AbortController();
    let resolveShared: ((value: string) => void) | undefined;
    const shared = withoutQueryAbortSignal(() => new Promise<string>((resolve) => {
      resolveShared = resolve;
    }));
    const waiter = withQueryAbortSignal(controller.signal, () => waitForQueryAbort(shared));

    controller.abort();
    await expect(waiter).rejects.toHaveProperty("name", "AbortError");

    if (!resolveShared) throw new Error("Expected shared work resolver");
    resolveShared("complete");
    await expect(shared).resolves.toBe("complete");
  });

  test("allows detached database work to outlive an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await withQueryAbortSignal(controller.signal, () =>
      withoutQueryAbortSignal(() => pool.get<{ value: number }>("SELECT 1 AS value"))
    );

    expect(result).toEqual({ value: 1 });
  });
});
