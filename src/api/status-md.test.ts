import { afterEach, describe, expect, it } from "bun:test";
import { getAppStateDb } from "../db/app-state";
import { getDb } from "../db/schema";
import { upsertSyncSourcePatch } from "../sync/config";
import { seed } from "../testing/seed";
import { app } from "./index";

it("reports the latest processed file type in inbox status", async () => {
  const db = getAppStateDb();
  const source = "test-inbox-source";
  try {
    db.prepare(
      `INSERT INTO processed_files (source, file_path, file_hash, file_size, processed_at, detected_type)
       VALUES (?, 'new.json', 'new', 20, '2026-01-02 00:00:00', 'json'),
              (?, 'old.csv', 'old', 10, '2026-01-01 00:00:00', 'csv')`,
    ).run(source, source);

    const response = await app.request("/api/status");
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.inbox.sources).toContainEqual({
      source,
      filesProcessed: 2,
      totalSize: 20,
      totalEvents: 0,
      lastProcessed: "2026-01-02 00:00:00",
      lastDetectedType: "json",
    });
  } finally {
    db.prepare("DELETE FROM processed_files WHERE source = ?").run(source);
  }
});

describe("/status.md sync history", () => {
  const sources = ["remote-agents", "test-deferred-source"];

  afterEach(() => {
    const db = getAppStateDb();
    for (const source of sources) db.prepare("DELETE FROM sync_log WHERE source = ?").run(source);
  });

  function insertRun(row: { source: string; skipped: number; eventsAdded: number; metadata: unknown }) {
    getAppStateDb()
      .prepare(
        `INSERT INTO sync_log (source, started_at, finished_at, success, skipped, events_added, events_updated, duration_ms, metadata)
         VALUES (?, datetime('now', '+1 day'), datetime('now', '+1 day'), 1, ?, ?, 0, 1500, ?)`,
      )
      .run(row.source, row.skipped, row.eventsAdded, JSON.stringify(row.metadata));
  }

  it("shows why a run was deferred", async () => {
    insertRun({
      source: "test-deferred-source",
      skipped: 1,
      eventsAdded: 0,
      metadata: { guard: "network", skipReason: "on a blocked Wi-Fi network" },
    });

    const res = await app.request("/status.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("| test-deferred-source | deferred: on a blocked Wi-Fi network |");
  });

  it("shows per-target details of a remote agents pull", async () => {
    insertRun({
      source: "remote-agents",
      skipped: 0,
      eventsAdded: 5,
      metadata: {
        host: "alice@agent-host",
        account: "alice@agent-host",
        targets: [
          { target: "claude-code", eventsAdded: 3, files: 2, bytes: 2048 },
          { target: "codex", eventsAdded: 2, files: 1, bytes: 1536 },
        ],
      },
    });

    const res = await app.request("/status.md");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      "| remote-agents | OK +5 events (1.5s); from alice@agent-host: claude-code +3 (2 KB mirrored), codex +2 (1.5 KB mirrored) |",
    );
  });
});

describe("/status.md sources", () => {
  afterEach(() => {
    getDb().prepare("DELETE FROM events WHERE source IN ('wakatime', 'swarm')").run();
    const appDb = getAppStateDb();
    appDb.prepare("DELETE FROM sync_sources WHERE source IN ('wakatime', 'swarm')").run();
    appDb.prepare("DELETE FROM sync_log WHERE source = 'wakatime'").run();
  });

  it("names a quiet source and says its sync still succeeds", async () => {
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO events (source, source_id, type, timestamp, raw_data, imported_at) VALUES (?, ?, 'test', ?, '{}', ?)",
    );
    seed(db, () => {
      for (let day = 0; day < 60; day++) {
        // WakaTime went quiet 12 days ago; Swarm checks in every few days and is current.
        const wakatime = new Date(Date.now() - (12 + day) * 86_400_000);
        insert.run("wakatime", `w${day}`, wakatime.toISOString(), wakatime.toISOString().replace("T", " ").slice(0, 19));
        const swarm = new Date(Date.now() - (1 + day * 3) * 86_400_000);
        insert.run("swarm", `s${day}`, swarm.toISOString(), swarm.toISOString().replace("T", " ").slice(0, 19));
      }
    });
    upsertSyncSourcePatch("wakatime", { enabled: true }, getAppStateDb());
    upsertSyncSourcePatch("swarm", { enabled: true }, getAppStateDb());
    getAppStateDb()
      .prepare(
        `INSERT INTO sync_log (source, started_at, finished_at, success, skipped, events_added, events_updated, duration_ms)
         VALUES ('wakatime', datetime('now', '-5 minutes'), datetime('now', '-5 minutes'), 1, 0, 0, 0, 800)`,
      )
      .run();

    const res = await app.request("/status.md");
    const text = await res.text();
    expect(text).toContain("| Quiet sources | wakatime |");
    expect(text).toContain(
      "| wakatime | " +
        new Date(Date.now() - 12 * 86_400_000).toISOString().slice(0, 10) +
        " (12d ago) | **Quiet**: quiet 12d, usually at most 1d without new events; last sync succeeded 5m ago |",
    );
    expect(text).toMatch(/\| swarm \| [\d-]+ \(1d ago\) \| OK, usually at most 3d without new events \|/);
  });
});

describe("retired source freshness", () => {
  const sources = ["steam-friends", "fitbit", "monzo", "trakt"];
  afterEach(() => {
    for (const source of sources) {
      getDb().prepare("DELETE FROM events WHERE source = ?").run(source);
      getAppStateDb().prepare("DELETE FROM sync_sources WHERE source = ?").run(source);
    }
  });

  it("distinguishes retired, import-only, disabled and quiet enabled sources without deleting settings", async () => {
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO events (source, source_id, type, timestamp, raw_data, imported_at) VALUES (?, ?, 'test', ?, '{}', ?)",
    );
    seed(db, () => {
      for (const source of sources) {
        for (let day = 10; day < 200; day++) {
          const date = new Date(Date.now() - day * 86_400_000).toISOString();
          insert.run(source, `retirement-${day}`, date, date);
        }
      }
    });
    for (const source of sources) upsertSyncSourcePatch(source, { enabled: source !== "trakt" }, getAppStateDb());

    const response = await app.request("/api/status");
    expect(response.status).toBe(200);
    const status = await response.json();
    const bySource = new Map(status.freshness.map((entry: { source: string }) => [entry.source, entry]));
    expect(bySource.get("steam-friends")).toMatchObject({ status: "unchecked", reason: "retired" });
    expect(bySource.get("fitbit")).toMatchObject({ status: "quiet", feed: "imports" });
    expect(bySource.get("monzo")).toMatchObject({ status: "quiet", feed: "sync" });
    expect(bySource.get("trakt")).toMatchObject({ status: "unchecked", reason: "sync-off" });

    const markdown = await (await app.request("/status.md")).text();
    expect(markdown).toMatch(/\| steam-friends \| .* \| Not checked: source retired \|/);
    expect(markdown).toMatch(/\| trakt \| .* \| Not checked: sync turned off \|/);
    for (const source of ["fitbit", "monzo"]) {
      expect(markdown).toMatch(new RegExp(`\\| ${source} \\| .* \\| \\*\\*Quiet\\*\\*:`));
    }
    expect(getAppStateDb().query("SELECT enabled FROM sync_sources WHERE source = 'steam-friends'").get()).toEqual({ enabled: 1 });
  });
});
