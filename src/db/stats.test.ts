/**
 * Tests for stats cache:
 * 1. Write-through on cache miss when writeDb is provided
 * 2. Cache hit returns cached data without recomputing
 * 3. No write when writeDb is omitted (read-only context)
 * 4. Invalidation marks cache stale and allows re-computation
 * 5. onImportComplete invalidates cache so next getStats recomputes
 * 6. Hidden contacts are excluded from stats
 * 7. Concurrent invalidation prevents stale write-through
 * 8. Stats aggregation uses one snapshot and hidden-first primary-key lookups
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { initDb } from "./schema";
import { wrapDatabase } from "./pool";
import {
  getStats,
  refreshStatsCache,
  invalidateStatsCache,
} from "./stats";
import { onImportComplete } from "./import-hooks";
import { invalidateHiddenClauseCaches } from "./events";

let db: Database;

function setup(): void {
  db = new Database(":memory:");
  initDb(db);
  invalidateHiddenClauseCaches();
}

function teardown(): void {
  invalidateHiddenClauseCaches();
  db.close();
}

function insertEvent(
  source: string,
  type: string,
  opts?: { import_batch?: string; timestamp?: string; people?: string[] },
): void {
  const timestamp = opts?.timestamp ?? "2024-01-15T12:00:00Z";
  const batch = opts?.import_batch ?? null;
  const people = opts?.people ? JSON.stringify(opts.people) : null;
  db.prepare(`
    INSERT INTO events (source, source_id, type, timestamp, import_batch, people, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, '{}')
  `).run(source, `test-${randomUUID()}`, type, timestamp, batch, people);
}

function getCacheRow(): { value: string } | null {
  return db.prepare("SELECT value FROM cache WHERE key = 'stats'").get() as {
    value: string;
  } | null;
}

function getCachedTotal(): number | null {
  const row = getCacheRow();
  if (!row) return null;
  const parsed = JSON.parse(row.value) as {
    total_events?: unknown;
    stats?: { total_events?: unknown };
  };
  const total = parsed.stats?.total_events ?? parsed.total_events;
  if (total === undefined) return null;
  if (typeof total !== "number") throw new Error("Cached stats total must be a number");
  return total;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("stats cache", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("write-through populates cache on miss when writeDb provided", async () => {
    insertEvent("spotify", "listen:track");
    insertEvent("discord", "message:dm");
    expect(getCacheRow()).toBeNull();

    const result = await getStats(wrapDatabase(db), db);

    expect(result.total_events).toBe(2);
    expect(result.sources).toContainEqual(
      expect.objectContaining({ source: "spotify", count: 1 }),
    );
    expect(getCachedTotal()).toBe(2);
  });

  test("cache hit returns cached data without recomputing", async () => {
    insertEvent("spotify", "listen:track");
    await refreshStatsCache(db);

    // Insert another event that won't be reflected in cache
    insertEvent("discord", "message:dm");

    const result = await getStats(wrapDatabase(db), db);
    // Should return stale cached data (total=1, not 2)
    expect(result.total_events).toBe(1);
  });

  test("no write when writeDb is omitted", async () => {
    insertEvent("spotify", "listen:track");

    const result = await getStats(wrapDatabase(db));

    expect(result.total_events).toBe(1);
    expect(getCacheRow()).toBeNull();
  });

  test("invalidation marks cache stale and allows re-computation", async () => {
    insertEvent("spotify", "listen:track");
    await refreshStatsCache(db);
    expect(getCacheRow()).not.toBeNull();

    invalidateStatsCache(db);
    expect(getCachedTotal()).toBeNull();

    // New event appears after invalidation
    insertEvent("discord", "message:dm");
    const result = await getStats(wrapDatabase(db), db);
    expect(result.total_events).toBe(2);
    expect(getCachedTotal()).toBe(2);
  });

  test("onImportComplete invalidates cache so next getStats recomputes", async () => {
    insertEvent("spotify", "listen:track");
    await refreshStatsCache(db);
    expect(getCachedTotal()).toBe(1);

    // Simulate an import adding new events
    insertEvent("discord", "message:dm");
    onImportComplete(db);

    expect(getCachedTotal()).toBeNull();

    // Next getStats should recompute with new data
    const result = await getStats(wrapDatabase(db), db);
    expect(result.total_events).toBe(2);
  });

  test("hidden contacts are excluded from stats", async () => {
    // Insert events: 2 with a person, 1 without
    insertEvent("discord", "message:dm", { people: ["discord:alice123"] });
    insertEvent("discord", "message:dm", { people: ["discord:alice123"] });
    insertEvent("spotify", "listen:track");

    // Verify event_people was populated by trigger
    const epCount = db.prepare("SELECT COUNT(*) as c FROM event_people").get() as { c: number };
    expect(epCount.c).toBe(2);

    // Without hidden contacts, all 3 events should be counted
    let result = await getStats(wrapDatabase(db), db);
    expect(result.total_events).toBe(3);
    expect(result.sources).toContainEqual(
      expect.objectContaining({ source: "discord", count: 2 }),
    );

    // Create a hidden contact with an identity matching the person
    db.prepare("INSERT INTO contacts (display_name, hidden) VALUES (?, 1)").run("Alice");
    const contactId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO identities (platform, platform_id, display_name, contact_id) VALUES (?, ?, ?, ?)"
    ).run("discord", "alice123", "Alice", contactId);

    // Invalidate caches so stats are recomputed
    invalidateHiddenClauseCaches();
    invalidateStatsCache(db);

    // Now stats should exclude the 2 discord events involving the hidden contact
    result = await getStats(wrapDatabase(db), db);
    expect(result.total_events).toBe(1);
    expect(result.sources).toContainEqual(
      expect.objectContaining({ source: "spotify", count: 1 }),
    );
    expect(result.sources).not.toContainEqual(
      expect.objectContaining({ source: "discord" }),
    );
  });

  test("hidden events are subtracted once and cannot define the visible date range", async () => {
    insertEvent("discord", "message:dm", {
      timestamp: "2020-01-01T00:00:00Z",
      people: ["discord:alice123", "slack:alice456"],
    });
    insertEvent("spotify", "listen:track", { timestamp: "2022-06-15T12:00:00Z" });
    insertEvent("discord", "message:dm", {
      timestamp: "2025-01-01T00:00:00Z",
      people: ["discord:alice123"],
    });

    db.prepare("INSERT INTO contacts (display_name, hidden) VALUES (?, 1)").run("Alice");
    const contactId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
    const insertIdentity = db.prepare(
      "INSERT INTO identities (platform, platform_id, display_name, contact_id) VALUES (?, ?, ?, ?)",
    );
    insertIdentity.run("discord", "alice123", "Alice", contactId);
    insertIdentity.run("slack", "alice456", "Alice", contactId);

    const statements: string[] = [];
    const executor = wrapDatabase(db);
    const recordingExecutor = {
      query: <T>(sql: string, ...params: unknown[]) => {
        statements.push(sql);
        return executor.query<T>(sql, ...params);
      },
      get: <T>(sql: string, ...params: unknown[]) => {
        statements.push(sql);
        return executor.get<T>(sql, ...params);
      },
    };

    const result = await getStats(recordingExecutor);

    expect(result.total_events).toBe(1);
    expect(result.sources).toEqual([
      { source: "spotify", type: "listen:track", count: 1 },
    ]);
    expect(result.date_range).toEqual({
      earliest: "2022-06-15T12:00:00Z",
      latest: "2022-06-15T12:00:00Z",
    });

    const computationStatements = statements.filter((sql) => sql.includes("WITH"));
    expect(computationStatements).toHaveLength(1);
    const computationSql = computationStatements[0];
    if (!computationSql) throw new Error("Expected stats computation SQL");
    expect(computationSql).toContain("CROSS JOIN events e");

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${computationSql}`).all() as { detail: string }[];
    const details = plan.map((row) => row.detail);
    expect(details.filter((detail) => detail.includes("USING COVERING INDEX idx_events_source_type")))
      .toHaveLength(1);
    expect(details).toContain("SCAN hidden");
    expect(details).toContain("SEARCH e USING INTEGER PRIMARY KEY (rowid=?)");
  });

  test("invalidation during a fill prevents stale persistent write-through", async () => {
    insertEvent("spotify", "listen:track");

    const baseExecutor = wrapDatabase(db);
    const queryStarted = deferred<void>();
    const staleRows = deferred<unknown[]>();
    const controlledExecutor = {
      get: <T>(sql: string, ...params: unknown[]) => baseExecutor.get<T>(sql, ...params),
      query: <T>(_sql: string, ..._params: unknown[]) => {
        queryStarted.resolve();
        return staleRows.promise as Promise<T[]>;
      },
    };

    const staleRequest = getStats(controlledExecutor, db);
    await queryStarted.promise;

    insertEvent("discord", "message:dm");
    invalidateStatsCache(db);
    staleRows.resolve([
      {
        row_kind: 0,
        source: null,
        type: null,
        count: 1,
        earliest: "2024-01-15T12:00:00Z",
        latest: "2024-01-15T12:00:00Z",
      },
      {
        row_kind: 1,
        source: "spotify",
        type: "listen:track",
        count: 1,
        earliest: null,
        latest: null,
      },
    ]);

    expect((await staleRequest).total_events).toBe(1);
    expect(getCachedTotal()).toBeNull();

    const fresh = await getStats(baseExecutor, db);
    expect(fresh.total_events).toBe(2);
    expect(getCachedTotal()).toBe(2);
  });

});
