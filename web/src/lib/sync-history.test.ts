import { describe, expect, it } from "vitest";
import type { SyncHistoryEntry } from "./api";
import {
  getRemainingQueueDepthSeries,
  getSyncHistoryFailureCount,
  getSyncHistoryWarning,
  historyStatusLabel,
  parseSyncHistoryMetadata,
} from "./sync-history";

function historyEntry(metadata: string | null): SyncHistoryEntry {
  return {
    id: 1,
    job_id: null,
    source: "attachment-descriptions",
    started_at: "2026-07-10 12:00:00",
    finished_at: "2026-07-10 12:05:00",
    success: 1,
    skipped: 0,
    events_added: 2,
    events_updated: 0,
    error: null,
    duration_ms: 300_000,
    metadata,
  };
}

describe("sync history metadata", () => {
  it("reads a positive failure count", () => {
    const entry = historyEntry('{"failed":2}');
    expect(getSyncHistoryFailureCount(entry)).toBe(2);
    expect(getSyncHistoryWarning(entry)).toEqual({
      failed: 2,
      message: "2 items failed during this run",
    });
  });

  it("does not turn invalid metadata into a warning", () => {
    expect(getSyncHistoryFailureCount(historyEntry(null))).toBe(0);
    expect(getSyncHistoryFailureCount(historyEntry("not json"))).toBe(0);
    expect(getSyncHistoryFailureCount(historyEntry('{"failed":0}'))).toBe(0);
    expect(getSyncHistoryFailureCount(historyEntry('{"failed":"2"}'))).toBe(0);
    expect(parseSyncHistoryMetadata("not json")).toBeNull();
  });

  it("does not warn for a failed run because failure status takes precedence", () => {
    const entry = historyEntry('{"failed":2}');
    entry.success = 0;
    expect(getSyncHistoryWarning(entry)).toBeNull();
  });

  it("labels a skipped run with an error as blocked", () => {
    const entry = historyEntry(null);
    entry.skipped = 1;
    entry.error = "Spotify missing refresh token";

    expect(historyStatusLabel(entry)).toEqual({
      label: "Blocked: Spotify missing refresh token",
      className: "text-red-400",
      title: "Spotify missing refresh token",
    });
  });

  it("keeps a skipped run without an error deferred", () => {
    const entry = historyEntry('{"guard":"network","skipReason":"offline"}');
    entry.skipped = 1;

    expect(historyStatusLabel(entry)).toEqual({ label: "Deferred", className: "text-yellow-400" });
  });

  it("extracts remaining queue depth in chronological completion order", () => {
    const latest = historyEntry('{"remainingQueueDepth":1200}');
    latest.id = 2;
    latest.started_at = "2026-07-10 13:00:00";
    latest.finished_at = "2026-07-10 13:05:00";
    const earliest = historyEntry('{"remainingQueueDepth":1500}');

    expect(getRemainingQueueDepthSeries([latest, earliest])).toEqual([
      { time: "2026-07-10T12:05:00Z", depth: 1500 },
      { time: "2026-07-10T13:05:00Z", depth: 1200 },
    ]);
  });

  it("ignores unfinished runs and invalid queue depth metadata", () => {
    const unfinished = historyEntry('{"remainingQueueDepth":1200}');
    unfinished.finished_at = null;

    expect(getRemainingQueueDepthSeries([
      unfinished,
      historyEntry('{"remainingQueueDepth":"1200"}'),
      historyEntry('{"remainingQueueDepth":-1}'),
      historyEntry('{"remainingQueueDepth":1.5}'),
      historyEntry("not json"),
    ])).toEqual([]);
  });
});
