/** Bucket key for attachments whose event has no usable timestamp. */
const UNDATED_KEY = "0000-00";

export function formatMonthYear(ts: string): string {
  const date = new Date(ts);
  return date.toLocaleDateString([], { month: "long", year: "numeric" });
}

/** Human label for a `YYYY-MM` bucket key produced by {@link monthKey}. */
export function formatMonthKey(month: string): string {
  if (month === UNDATED_KEY) return "Undated";
  return formatMonthYear(`${month}-01`);
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  return `0:${String(seconds).padStart(2, "0")}`;
}

/** Stable `YYYY-MM` bucket key; undated items collapse into one trailing group. */
export function monthKey(timestamp: string | null): string {
  if (!timestamp) return UNDATED_KEY;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return UNDATED_KEY;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Group timestamped items into `YYYY-MM` buckets, preserving input order. The
 * caller supplies items already ordered newest-first, so Map iteration yields
 * months newest-first with any undated bucket last.
 */
export function groupByMonth<T extends { timestamp: string | null }>(
  items: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = monthKey(item.timestamp);
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(item);
  }
  return groups;
}
