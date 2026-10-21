import type { SyncHistoryEntry } from "./api";

export function parseSyncHistoryMetadata(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function getSyncHistoryFailureCount(entry: SyncHistoryEntry): number {
  const metadata = parseSyncHistoryMetadata(entry.metadata);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 0;
  const failed = (metadata as Record<string, unknown>).failed;
  return typeof failed === "number" && Number.isInteger(failed) && failed > 0 ? failed : 0;
}

export function getSyncHistoryWarning(entry: SyncHistoryEntry): { failed: number; message: string } | null {
  if (entry.success !== 1) return null;
  const failed = getSyncHistoryFailureCount(entry);
  if (failed === 0) return null;
  return {
    failed,
    message: `${failed} ${failed === 1 ? "item" : "items"} failed during this run`,
  };
}

export function historyStatusLabel(entry: SyncHistoryEntry): { label: string; className: string; title?: string } {
  if (entry.skipped === 1) {
    if (entry.error !== null) {
      return {
        label: `Blocked: ${entry.error.slice(0, 60)}`,
        className: "text-red-400",
        title: entry.error,
      };
    }
    return { label: "Deferred", className: "text-yellow-400" };
  }
  const warning = getSyncHistoryWarning(entry);
  if (warning) {
    return {
      label: `Warnings (${warning.failed} failed)`,
      className: "text-yellow-400",
      title: warning.message,
    };
  }
  if (entry.success === 1) return { label: "OK", className: "text-green-400" };
  return {
    label: `Failed${entry.error ? `: ${entry.error.slice(0, 60)}` : ""}`,
    className: "text-red-400",
    title: entry.error ?? undefined,
  };
}

export interface RemainingQueueDepthPoint {
  time: string;
  depth: number;
}

/**
 * Extract completed-run queue readings from source-specific sync metadata.
 * Sync history is newest-first; charts consume these oldest-first.
 */
export function getRemainingQueueDepthSeries(
  entries: SyncHistoryEntry[]
): RemainingQueueDepthPoint[] {
  const points: RemainingQueueDepthPoint[] = [];

  for (const entry of entries) {
    if (!entry.finished_at) continue;
    const metadata = parseSyncHistoryMetadata(entry.metadata);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    const depth = (metadata as Record<string, unknown>).remainingQueueDepth;
    if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0) continue;

    points.push({
      time: `${entry.finished_at.replace(" ", "T")}Z`,
      depth,
    });
  }

  return points.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
