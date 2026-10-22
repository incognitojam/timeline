import { afterEach, describe, expect, it } from "bun:test";
import { getAppStateDb } from "../db/app-state";
import { app } from "./index";

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
