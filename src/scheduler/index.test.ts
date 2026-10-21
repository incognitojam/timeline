import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ServiceConfig } from "../config";
import { getAppStateDb, setBlockedNetworks } from "../db/app-state";
import { listJobs } from "../jobs/store";
import { LocalWorkGate } from "../jobs/local-work";
import { workerTestHooks } from "./worker";
import { attachmentDescriptionsSyncSource } from "../sync/sources/attachment-descriptions";
import type { SyncSource } from "../sync/types";
import { Scheduler } from "./index";

function sqliteTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function testConfig(source: string): ServiceConfig {
  return {
    server: { host: "127.0.0.1", port: 3001 },
    database: { path: process.env.TIMELINE_DB_PATH ?? ":memory:" },
    scheduler: {
      enabled: true,
      default_interval: "1h",
      stagger: false,
    },
    sync: {
      [source]: {
        enabled: true,
        interval: "1h",
      },
    },
    inbox: {
      watch_enabled: false,
      base_path: "/tmp/timeline-inbox",
      sources: {},
    },
    media: {
      path: "/tmp/timeline-media",
    },
    backup: {},
    llm: { providers: {} },
  };
}

function insertSyncSource(source: string, enabled = true, interval = "1h"): void {
  getAppStateDb()
    .prepare("INSERT OR REPLACE INTO sync_sources (source, enabled, interval, settings) VALUES (?, ?, ?, '{}')")
    .run(source, enabled ? 1 : 0, interval);
}

describe("scheduler", () => {
  beforeEach(() => {
    const db = getAppStateDb();
    db.prepare("DELETE FROM scheduler_state WHERE source LIKE 'scheduler-test-%'").run();
    db.prepare("DELETE FROM sync_log WHERE source LIKE 'scheduler-test-%'").run();
    db.prepare("DELETE FROM jobs WHERE source LIKE 'scheduler-test-%'").run();
    db.prepare("DELETE FROM sync_sources WHERE source LIKE 'scheduler-test-%'").run();
  });

  test("ignores a retired source on startup without reading its stale settings", async () => {
    const source = "scheduler-test-retired";
    const db = getAppStateDb();
    db.prepare(
      "INSERT INTO sync_sources (source, enabled, interval, settings) VALUES (?, 1, 'invalid', 'invalid')",
    ).run(source);
    db.prepare(
      "INSERT INTO scheduler_state (source, interval_ms, enabled) VALUES (?, 3600000, 1)",
    ).run(source);
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = new Scheduler(testConfig(source), { syncSources: [] });

    try {
      await scheduler.start();
      expect(warnings.mock.calls.some(([message]) => String(message).includes(source))).toBe(true);
      expect(scheduler.getStatus().some((task) => task.source === source)).toBe(false);
      expect(await scheduler.runNow(source)).toMatchObject({
        success: false,
        error: `Unknown source: ${source}`,
      });
    } finally {
      scheduler.stop();
      warnings.mockRestore();
      db.prepare("DELETE FROM scheduler_state WHERE source = ?").run(source);
      db.prepare("DELETE FROM sync_sources WHERE source = ?").run(source);
    }
  });

  test("worker dispatch passes local ownership through the scheduler to the source", async () => {
    const source = "scheduler-test-local-work";
    insertSyncSource(source);
    const gate = new LocalWorkGate();
    const controller = new AbortController();
    let observed = false;
    const syncSource: SyncSource = {
      name: source, description: "Local-work forwarding test", enabled: true,
      canSync: async () => null,
      sync: async (options) => {
        expect(options.localWork).toBe(gate);
        expect(options.signal?.aborted).toBe(false);
        controller.abort();
        expect(options.signal?.aborted).toBe(true);
        observed = true;
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    };
    const scheduler = new Scheduler(testConfig(source), { syncSources: [syncSource] });
    const handler = workerTestHooks.buildHandlers(scheduler, null).sync;
    if (!handler) throw new Error("No sync handler");
    await handler({
      id: 1, kind: "sync", source, payload: {}, dedupeKey: null, status: "running", priority: 0,
      attempt: 1, maxAttempts: 1, enqueuedAt: "2026-01-01", notBefore: "2026-01-01", startedAt: "2026-01-01",
      finishedAt: null, workerId: "test", workerLeaseUntil: null, result: null, error: null, trigger: "manual",
    }, controller.signal, gate);
    expect(observed).toBe(true);
  });

  test("cancelling description initialization closes its sync log while local work stays busy", async () => {
    const source = "scheduler-test-description-entry";
    insertSyncSource(source);
    const gate = new LocalWorkGate();
    const finishLocal = Promise.withResolvers<void>();
    const local = gate.run(() => finishLocal.promise);
    const requests = spyOn(gate, "run");
    const controller = new AbortController();
    const scheduler = new Scheduler(testConfig(source), {
      syncSources: [{
        ...attachmentDescriptionsSyncSource,
        name: source,
        canSync: async () => null,
        sync: async (options) => ({
          ...await attachmentDescriptionsSyncSource.sync({
            ...options,
            config: { sources: { "attachment-descriptions": { models: ["vision"] } } },
          }),
          source,
        }),
      }],
    });
    const running = scheduler.runNow(source, 123, controller.signal, "manual", gate);
    try {
      for (let attempt = 0; attempt < 100 && requests.mock.calls.length === 0; attempt++) await Bun.sleep(2);
      expect(requests.mock.calls).toHaveLength(1);
      controller.abort(new Error("Stopped before initialization"));
      expect(await running).toMatchObject({ success: false, error: "Stopped before initialization" });
      const log = getAppStateDb().prepare("SELECT finished_at, error FROM sync_log WHERE source = ?").get(source) as { finished_at: string | null; error: string };
      expect(log.finished_at).not.toBeNull();
      expect(log.error).toBe("Stopped before initialization");
    } finally {
      controller.abort();
      finishLocal.resolve();
      await local;
      await running;
      requests.mockRestore();
    }
  });

  test("a manual run pushes the next scheduled sync out by the interval", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(source);
    const intervalMs = 60 * 60 * 1000;
    const originallyDueAt = new Date(Date.now() + 8 * 60 * 1000);

    const db = getAppStateDb();
    db.prepare(
      `INSERT INTO scheduler_state (source, interval_ms, enabled, next_run_at)
       VALUES (?, ?, 1, ?)`
    ).run(source, intervalMs, sqliteTimestamp(originallyDueAt));

    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return null;
      },
      async sync() {
        return {
          source,
          success: true,
          eventsAdded: 0,
          eventsUpdated: 0,
          durationMs: 1,
        };
      },
    };

    const beforeRun = Date.now();
    const scheduler = new Scheduler(testConfig(source), { syncSources: [syncSource] });
    const result = await scheduler.runNow(source, null);
    const afterRun = Date.now();

    expect(result.success).toBe(true);

    const state = db
      .prepare("SELECT last_run_at, next_run_at FROM scheduler_state WHERE source = ?")
      .get(source) as { last_run_at: string | null; next_run_at: string | null } | null;

    expect(state?.last_run_at).not.toBeNull();
    expect(state?.next_run_at).not.toBeNull();

    const nextRunAt = new Date(`${state?.next_run_at}Z`).getTime();
    expect(nextRunAt).toBeGreaterThanOrEqual(beforeRun + intervalMs);
    expect(nextRunAt).toBeLessThanOrEqual(afterRun + intervalMs + 1000);
    expect(nextRunAt).toBeGreaterThan(originallyDueAt.getTime());
  });

  test("a canSync refusal records a skipped sync_log row with its reason", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    const reason = "Spotify missing refresh token. Run: bun run src/parsers/spotify-api.ts auth";
    insertSyncSource(source);
    const db = getAppStateDb();

    let syncCalls = 0;
    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return reason;
      },
      async sync() {
        syncCalls++;
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    };

    const scheduler = new Scheduler(testConfig(source), { syncSources: [syncSource] });
    const result = await scheduler.runNow(source, 123, undefined, "manual");

    expect(result).toMatchObject({ source, success: true, skipped: true, error: reason });
    expect(syncCalls).toBe(0);

    const row = db
      .prepare("SELECT job_id, success, skipped, error FROM sync_log WHERE source = ?")
      .get(source) as { job_id: number | null; success: number; skipped: number; error: string | null } | null;
    expect(row).toEqual({ job_id: 123, success: 1, skipped: 1, error: reason });
  });

  test("a guard deferral records a skipped sync_log row and does not run sync()", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(source);
    const db = getAppStateDb();

    let syncCalls = 0;
    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return null;
      },
      async sync() {
        syncCalls++;
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    };

    const scheduler = new Scheduler(testConfig(source), {
      syncSources: [syncSource],
      guardCheck: async ({ source: s }) => ({
        source: s,
        success: true,
        skipped: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 1,
        metadata: { guard: "network", skipReason: 'blocked Wi-Fi "iPhone"' },
      }),
    });

    const result = await scheduler.runNow(source, null, undefined, "scheduler");

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(syncCalls).toBe(0);

    const row = db
      .prepare("SELECT success, skipped, metadata FROM sync_log WHERE source = ?")
      .get(source) as { success: number; skipped: number; metadata: string | null } | null;
    expect(row?.success).toBe(1);
    expect(row?.skipped).toBe(1);
    expect(JSON.parse(row?.metadata ?? "{}").skipReason).toContain("iPhone");
  });

  test("the guard receives the shared blocked-network list", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(source);
    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return null;
      },
      async sync() {
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    };

    let received: string[] | undefined;
    const scheduler = new Scheduler(testConfig(source), {
      syncSources: [syncSource],
      guardCheck: async ({ blockedNetworks }) => {
        received = blockedNetworks;
        return null;
      },
    });

    setBlockedNetworks(getAppStateDb(), ["iPhone", "Train WiFi"]);
    try {
      await scheduler.runNow(source, null, undefined, "scheduler");
    } finally {
      setBlockedNetworks(getAppStateDb(), []);
    }

    expect(received).toEqual(["iPhone", "Train WiFi"]);
  });

  test("a manual trigger bypasses the guard and runs sync()", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(source);
    const db = getAppStateDb();

    let syncCalls = 0;
    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return null;
      },
      async sync() {
        syncCalls++;
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    };

    let guardCalls = 0;
    const scheduler = new Scheduler(testConfig(source), {
      syncSources: [syncSource],
      guardCheck: async ({ source: s }) => {
        guardCalls++;
        return { source: s, success: true, skipped: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    });

    const result = await scheduler.runNow(source, null, undefined, "manual");

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(guardCalls).toBe(0);
    expect(syncCalls).toBe(1);

    const row = db
      .prepare("SELECT skipped FROM sync_log WHERE source = ?")
      .get(source) as { skipped: number } | null;
    expect(row?.skipped).toBe(0);
  });

  test("a source hard-disabled in code cannot run manually", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(source);

    let syncCalls = 0;
    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: false,
      async canSync() {
        return null;
      },
      async sync() {
        syncCalls++;
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    };

    const scheduler = new Scheduler(testConfig(source), { syncSources: [syncSource] });
    const result = await scheduler.runNow(source, null, undefined, "manual");

    expect(result).toMatchObject({
      source,
      success: false,
      error: `Source disabled: ${source}`,
    });
    expect(syncCalls).toBe(0);
  });

  test("a scheduled tick does not enqueue a follow-up while the source is running", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(source);
    const intervalMs = 60 * 60 * 1000;
    const originallyDueAt = new Date(Date.now() + 25);

    const db = getAppStateDb();
    db.prepare(
      `INSERT INTO scheduler_state (source, interval_ms, enabled, next_run_at)
       VALUES (?, ?, 1, ?)`
    ).run(source, intervalMs, sqliteTimestamp(originallyDueAt));

    let markStarted: (() => void) | undefined;
    const syncStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishSync: (() => void) | undefined;
    const syncCanFinish = new Promise<void>((resolve) => {
      finishSync = resolve;
    });

    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return null;
      },
      async sync() {
        if (!markStarted) {
          throw new Error("sync start resolver was not initialized");
        }
        markStarted();
        await syncCanFinish;
        return {
          source,
          success: true,
          eventsAdded: 0,
          eventsUpdated: 0,
          durationMs: 1,
        };
      },
    };

    const scheduler = new Scheduler(testConfig(source), { syncSources: [syncSource] });
    await scheduler.start();
    const run = scheduler.runNow(source, null);

    try {
      await syncStarted;
      await Bun.sleep(75);

      const queuedJobs = listJobs({ kind: "sync", source, limit: 10 }, db);
      expect(queuedJobs).toHaveLength(0);

      if (!finishSync) {
        throw new Error("sync finish resolver was not initialized");
      }
      finishSync();
      await run;
    } finally {
      if (finishSync) {
        finishSync();
      }
      await run.catch(() => undefined);
      scheduler.stop();
    }
  });

  test("a scheduled tick does not enqueue after the source is disabled", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(source);
    const intervalMs = 60 * 60 * 1000;
    const originallyDueAt = new Date(Date.now() + 25);

    const db = getAppStateDb();
    db.prepare(
      `INSERT INTO scheduler_state (source, interval_ms, enabled, next_run_at)
       VALUES (?, ?, 1, ?)`
    ).run(source, intervalMs, sqliteTimestamp(originallyDueAt));

    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return null;
      },
      async sync() {
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    };

    const scheduler = new Scheduler(testConfig(source), { syncSources: [syncSource] });
    await scheduler.start();

    try {
      db.prepare("UPDATE sync_sources SET enabled = 0 WHERE source = ?").run(source);
      await Bun.sleep(75);

      const queuedJobs = listJobs({ kind: "sync", source, limit: 10 }, db);
      expect(queuedJobs).toHaveLength(0);
    } finally {
      scheduler.stop();
    }
  });

  test("reloadSyncConfig unschedules a disabled source", async () => {
    const source = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(source);

    const syncSource: SyncSource = {
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return null;
      },
      async sync() {
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    };

    const scheduler = new Scheduler(testConfig(source), { syncSources: [syncSource] });
    await scheduler.start();

    const db = getAppStateDb();
    db.prepare("UPDATE sync_sources SET enabled = 0 WHERE source = ?").run(source);
    await scheduler.reloadSyncConfig();

    try {
      const state = db
        .prepare("SELECT enabled, next_run_at FROM scheduler_state WHERE source = ?")
        .get(source) as { enabled: number; next_run_at: string | null } | null;

      expect(state).toMatchObject({
        enabled: 0,
        next_run_at: null,
      });
      expect(scheduler.getStatus().find((task) => task.source === source)?.enabled).toBe(false);
    } finally {
      scheduler.stop();
    }
  });

  test("reloadSyncConfig reschedules with an updated interval", async () => {
    const shortenSource = `scheduler-test-${crypto.randomUUID()}`;
    const lengthenSource = `scheduler-test-${crypto.randomUUID()}`;
    insertSyncSource(shortenSource, true, "1h");
    insertSyncSource(lengthenSource, true, "1h");

    const createSyncSource = (source: string): SyncSource => ({
      name: source,
      description: "Test sync source",
      enabled: true,
      async canSync() {
        return null;
      },
      async sync() {
        return { source, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 1 };
      },
    });

    const oldIntervalMs = 60 * 60 * 1000;
    const lastRunAt = new Date(Date.now() - 30 * 60 * 1000);
    const staleNextRunAt = new Date(lastRunAt.getTime() + oldIntervalMs);
    const db = getAppStateDb();
    db.prepare(
      `INSERT INTO scheduler_state (source, last_run_at, next_run_at, interval_ms, enabled)
       VALUES (?, ?, ?, ?, 1)`
    ).run(shortenSource, sqliteTimestamp(lastRunAt), sqliteTimestamp(staleNextRunAt), oldIntervalMs);
    db.prepare(
      `INSERT INTO scheduler_state (source, last_run_at, next_run_at, interval_ms, enabled)
       VALUES (?, ?, ?, ?, 1)`
    ).run(lengthenSource, sqliteTimestamp(lastRunAt), sqliteTimestamp(staleNextRunAt), oldIntervalMs);

    const scheduler = new Scheduler(testConfig(shortenSource), {
      syncSources: [createSyncSource(shortenSource), createSyncSource(lengthenSource)],
    });
    await scheduler.start();

    db.prepare("UPDATE sync_sources SET interval = '15m' WHERE source = ?").run(shortenSource);
    db.prepare("UPDATE sync_sources SET interval = '2h' WHERE source = ?").run(lengthenSource);
    const beforeReload = Date.now();
    await scheduler.reloadSyncConfig();
    const afterReload = Date.now();

    try {
      const rows = db
        .prepare("SELECT source, interval_ms, enabled, next_run_at FROM scheduler_state WHERE source IN (?, ?)")
        .all(shortenSource, lengthenSource) as Array<{
        source: string;
        interval_ms: number;
        enabled: number;
        next_run_at: string | null;
      }>;
      const bySource = new Map(rows.map((row) => [row.source, row]));

      const shortened = bySource.get(shortenSource);
      const lengthened = bySource.get(lengthenSource);
      if (!shortened?.next_run_at || !lengthened?.next_run_at) {
        throw new Error("expected scheduler state to include next_run_at values");
      }

      expect(shortened).toMatchObject({
        interval_ms: 15 * 60 * 1000,
        enabled: 1,
      });
      const shortenedNextRunAt = new Date(`${shortened.next_run_at}Z`).getTime();
      expect(shortenedNextRunAt).toBeGreaterThanOrEqual(beforeReload);
      expect(shortenedNextRunAt).toBeLessThanOrEqual(afterReload + 1000);
      expect(shortenedNextRunAt).toBeLessThan(staleNextRunAt.getTime());

      expect(lengthened).toMatchObject({
        interval_ms: 2 * 60 * 60 * 1000,
        enabled: 1,
      });
      const lengthenedNextRunAt = new Date(`${lengthened.next_run_at}Z`).getTime();
      const expectedLengthenedNextRunAt = lastRunAt.getTime() + 2 * 60 * 60 * 1000;
      expect(lengthenedNextRunAt).toBeGreaterThan(staleNextRunAt.getTime());
      expect(lengthenedNextRunAt).toBeGreaterThanOrEqual(expectedLengthenedNextRunAt - 1000);
      expect(lengthenedNextRunAt).toBeLessThanOrEqual(expectedLengthenedNextRunAt + 1000);

      const statusBySource = new Map(scheduler.getStatus().map((task) => [task.source, task]));
      expect(statusBySource.get(shortenSource)?.intervalMs).toBe(15 * 60 * 1000);
      expect(statusBySource.get(shortenSource)?.nextRunAt?.getTime()).toBe(shortenedNextRunAt);
      expect(statusBySource.get(lengthenSource)?.intervalMs).toBe(2 * 60 * 60 * 1000);
      expect(statusBySource.get(lengthenSource)?.nextRunAt?.getTime()).toBe(lengthenedNextRunAt);
    } finally {
      scheduler.stop();
    }
  });
});
