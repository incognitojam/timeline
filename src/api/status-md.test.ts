import { afterEach, describe, expect, it } from "bun:test";
import { getAppStateDb } from "../db/app-state";
import { app } from "./index";

describe("/status.md sync history", () => {
  const sources = ["test-deferred-source"];

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
});
