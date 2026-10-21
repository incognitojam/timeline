import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { initAppStateDb } from "../db/app-state";
import { formatSyncResult, getAttachmentDescriptionHistory } from "./log";
import type { SyncResult } from "./types";

describe("formatSyncResult", () => {
  // Helper to strip ANSI color codes for easier assertions
  const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, "");

  describe("backup source with metadata", () => {
    test("formats normal backup with size and deleted count", () => {
      const result: SyncResult = {
        source: "backup",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 2500,
        metadata: { sizeMB: 1024, deleted: 3 },
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup: 1.0 GB, 3 deleted (2.5s)");
    });

    test("formats backup with size under 1GB", () => {
      const result: SyncResult = {
        source: "backup",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 1000,
        metadata: { sizeMB: 512, deleted: 0 },
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup: 512 MB (1.0s)");
    });

    test("formats backup with 0 MB size", () => {
      const result: SyncResult = {
        source: "backup",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 500,
        metadata: { sizeMB: 0, deleted: 1 },
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup: 0 MB, 1 deleted (0.5s)");
    });

    test("formats backup with only deleted count (no size)", () => {
      const result: SyncResult = {
        source: "backup",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 1000,
        metadata: { deleted: 5 },
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup: 5 deleted (1.0s)");
    });

    test("formats backup with empty metadata", () => {
      const result: SyncResult = {
        source: "backup",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 1000,
        metadata: {},
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup: backup complete (1.0s)");
    });

    test("formats backup with size only (no deleted)", () => {
      const result: SyncResult = {
        source: "backup",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 3000,
        metadata: { sizeMB: 2048 },
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup: 2.0 GB (3.0s)");
    });

    test("formats backup with size and deleted", () => {
      const result: SyncResult = {
        source: "backup",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 12300,
        metadata: { sizeMB: 1843, deleted: 4 },
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup: 1.8 GB, 4 deleted (12.3s)");
    });

    test("formats backup-app-state source", () => {
      const result: SyncResult = {
        source: "backup-app-state",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 500,
        metadata: { sizeMB: 25 },
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup-app-state: 25 MB (0.5s)");
    });

  });

  describe("backup source without metadata", () => {
    test("falls back to event count format when no metadata", () => {
      const result: SyncResult = {
        source: "backup",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 1000,
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ backup: 0 events (1.0s)");
    });
  });

  describe("non-backup sources", () => {
    test("formats successful sync with events added", () => {
      const result: SyncResult = {
        source: "discord",
        success: true,
        eventsAdded: 150,
        eventsUpdated: 0,
        durationMs: 5000,
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ discord: +150 events (5.0s)");
    });

    test("formats successful sync with events added and updated", () => {
      const result: SyncResult = {
        source: "github",
        success: true,
        eventsAdded: 10,
        eventsUpdated: 5,
        durationMs: 2000,
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ github: +10, ~5 events (2.0s)");
    });

    test("formats successful sync with no events", () => {
      const result: SyncResult = {
        source: "trakt",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 1500,
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✓ trakt: 0 events (1.5s)");
    });
  });

  describe("failed syncs", () => {
    test("formats failed sync with error message", () => {
      const result: SyncResult = {
        source: "monzo",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 500,
        error: "Token expired",
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✗ monzo: Token expired (0.5s)");
    });

    test("formats failed backup with error", () => {
      const result: SyncResult = {
        source: "backup",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: 100,
        error: "Disk full",
        metadata: { sizeMB: 1024 },
      };
      const formatted = stripAnsi(formatSyncResult(result));
      expect(formatted).toBe("✗ backup: Disk full (0.1s)");
    });
  });
});

describe("getAttachmentDescriptionHistory", () => {
  test("rolls queue gauges and outcomes into UTC days", () => {
    const db = new Database(":memory:");
    initAppStateDb(db);
    const insert = db.prepare(`
      INSERT INTO sync_log (
        source, started_at, finished_at, success, skipped, metadata
      ) VALUES ('attachment-descriptions', ?, ?, ?, ?, ?)
    `);

    insert.run(
      "2026-08-01 10:00:00",
      "2026-08-01 10:05:00",
      1,
      0,
      JSON.stringify({
        remainingQueueDepth: 100,
        descriptionEligibleHashes: 120,
        describedHashes: 20,
        described: 10,
        skipped: 1,
        failed: 0,
      }),
    );
    insert.run(
      "2026-08-01 18:00:00",
      "2026-08-01 18:05:00",
      0,
      0,
      JSON.stringify({
        remainingQueueDepth: 80,
        descriptionEligibleHashes: 120,
        describedHashes: 40,
        described: 5,
        skipped: 0,
        failed: 2,
      }),
    );
    insert.run(
      "2026-08-02 08:00:00",
      "2026-08-02 08:00:00",
      1,
      1,
      JSON.stringify({
        remainingQueueDepth: 70,
        descriptionEligibleHashes: 50,
        describedHashes: 60,
      }),
    );
    insert.run(
      "2026-08-02 09:00:00",
      "2026-08-02 09:00:00",
      0,
      0,
      "not json",
    );

    expect(getAttachmentDescriptionHistory(db)).toEqual([
      {
        date: "2026-08-01",
        queueDepth: 80,
        descriptionEligibleHashes: 120,
        describedHashes: 40,
        described: 15,
        skipped: 1,
        failed: 2,
        runs: 2,
        failedRuns: 1,
        deferredRuns: 0,
      },
      {
        date: "2026-08-02",
        queueDepth: 70,
        descriptionEligibleHashes: null,
        describedHashes: null,
        described: 0,
        skipped: 0,
        failed: 0,
        runs: 2,
        failedRuns: 1,
        deferredRuns: 1,
      },
    ]);

    db.close();
  });
});
