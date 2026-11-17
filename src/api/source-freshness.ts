import type { Database } from "bun:sqlite";
import { getAppStateDb } from "../db/app-state";
import { openReadonlyTimelineDb } from "../db/readonly";
import { QUIET_RULE, type SourceFeed, type SourceFreshness } from "../shared/source-freshness";
import { SYSTEM_SOURCES } from "../shared/system-sources";
import { loadSyncSourcesConfig } from "../sync/config";
import { SYNC_SOURCES } from "../sync/sources";

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/** Journal entries and manual notes are written when the owner chooses to. */
const APP_WRITTEN_SOURCES = new Set(SYSTEM_SOURCES.map((source) => source.id));

export interface FreshnessOptions {
  now: number;
  /** Configured sync sources: whether each is enabled. Others are import-only. */
  syncEnabled: ReadonlyMap<string, boolean>;
}

/** Stored timestamps are ISO 8601 with or without a zone, or SQLite's `YYYY-MM-DD HH:MM:SS` (UTC). */
function timestampMs(timestamp: string): number {
  const iso = timestamp.includes("T") ? timestamp : timestamp.replace(" ", "T");
  const zoned = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) || iso.length === 10 ? iso : `${iso}Z`;
  const ms = Date.parse(zoned);
  if (Number.isNaN(ms)) throw new Error(`Unparseable event timestamp: ${timestamp}`);
  return ms;
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY_MS;
}

interface ActiveDay {
  /** YYYY-MM-DD of the events, in their own offset. */
  day: string;
  /** UTC day the day's latest event was imported. */
  importedDay: string;
}

/**
 * Longest the source went without new events between consecutive days with
 * events (newest first). A sync delivers events as they happen, so that is the
 * gap between the days. An import-only source's events wait for the next
 * import, so its gap runs until the newer day's events were imported.
 */
function longestWait(days: readonly ActiveDay[], feed: SourceFeed): number {
  let longest = 0;
  for (let i = 1; i < days.length; i++) {
    const older = dayNumber(days[i].day);
    const newer = dayNumber(days[i - 1].day);
    const arrived = feed === "imports" ? Math.max(newer, dayNumber(days[i - 1].importedDay)) : newer;
    longest = Math.max(longest, arrived - older);
  }
  return longest;
}

/**
 * Newest event and usual gap for every source in the events table. Each source
 * costs a few dozen seeks on `idx_events_source_timestamp`, independent of how
 * many events it has.
 */
export function computeSourceFreshness(db: Database, options: FreshnessOptions): SourceFreshness[] {
  // Skip-scan the source index: one seek per distinct source instead of a full scan.
  const sources = db
    .query(
      `WITH RECURSIVE s(source) AS (
         SELECT MIN(source) FROM events
         UNION ALL
         SELECT (SELECT MIN(source) FROM events WHERE source > s.source) FROM s WHERE s.source IS NOT NULL
       )
       SELECT source FROM s WHERE source IS NOT NULL`,
    )
    .all() as { source: string }[];

  const newestQuery = db.query(
    `SELECT timestamp, imported_at FROM events
     WHERE source = ? AND timestamp IS NOT NULL AND timestamp <= ?
     ORDER BY timestamp DESC LIMIT 1`,
  );
  const oldestQuery = db.query(
    `SELECT timestamp, imported_at FROM events
     WHERE source = ? AND timestamp IS NOT NULL
     ORDER BY timestamp ASC LIMIT 1`,
  );
  const previousQuery = db.query(
    `SELECT timestamp, imported_at FROM events
     WHERE source = ? AND timestamp IS NOT NULL AND timestamp < ?
     ORDER BY timestamp DESC LIMIT 1`,
  );

  const nowIso = new Date(options.now).toISOString();
  const results: SourceFreshness[] = [];

  for (const { source } of sources) {
    if (APP_WRITTEN_SOURCES.has(source)) continue;

    const newest = newestQuery.get(source, nowIso) as { timestamp: string; imported_at: string } | null;
    if (!newest || !DAY_PATTERN.test(newest.timestamp)) {
      results.push({ source, status: "undated" });
      continue;
    }
    const newestAt = new Date(timestampMs(newest.timestamp)).toISOString();
    const quietMs = Math.max(0, options.now - timestampMs(newest.timestamp));

    const syncEnabled = options.syncEnabled.get(source);
    if (syncEnabled === false) {
      results.push({ source, status: "unchecked", newestAt, reason: "sync-off" });
      continue;
    }
    let feed: SourceFeed = "sync";
    if (syncEnabled === undefined) {
      if (quietMs > QUIET_RULE.importRetireDays * DAY_MS) {
        results.push({ source, status: "unchecked", newestAt, reason: "finished" });
        continue;
      }
      // A one-off export lands in a single import; a fed source's newest event
      // arrives in a later import than its older ones.
      const probeBefore = new Date(timestampMs(newest.timestamp) - QUIET_RULE.importProbeDays * DAY_MS).toISOString();
      const probe = (newestQuery.get(source, probeBefore) ?? oldestQuery.get(source)) as { imported_at: string };
      if (probe.imported_at.slice(0, 10) === newest.imported_at.slice(0, 10)) {
        results.push({ source, status: "unchecked", newestAt, reason: "one-off" });
        continue;
      }
      feed = "imports";
    }

    // Most recent days with events, newest first, each with the day its latest event was imported.
    const days: ActiveDay[] = [{ day: newest.timestamp.slice(0, 10), importedDay: newest.imported_at.slice(0, 10) }];
    while (days.length < QUIET_RULE.historyDays) {
      const previous = previousQuery.get(source, days[days.length - 1].day) as {
        timestamp: string;
        imported_at: string;
      } | null;
      if (!previous || !DAY_PATTERN.test(previous.timestamp)) break;
      days.push({ day: previous.timestamp.slice(0, 10), importedDay: previous.imported_at.slice(0, 10) });
    }
    if (days.length < QUIET_RULE.minActiveDays) {
      results.push({ source, status: "new", newestAt, feed, activeDays: days.length });
      continue;
    }

    const usualGapDays = longestWait(days, feed);
    const thresholdDays = Math.max(QUIET_RULE.gapMultiple * usualGapDays, QUIET_RULE.minQuietDays);
    results.push({
      source,
      status: quietMs > thresholdDays * DAY_MS ? "quiet" : "ok",
      newestAt,
      feed,
      quietDays: Math.floor(quietMs / DAY_MS),
      usualGapDays,
    });
  }
  return results;
}

const registeredSyncSources = new Set(SYNC_SOURCES.map((source) => source.name));

/** Freshness of every source in the live database, for the status page and `/api/status`. */
export function getSourceFreshness(now = Date.now()): SourceFreshness[] {
  const configured = loadSyncSourcesConfig(getAppStateDb(), registeredSyncSources);
  const syncEnabled = new Map(Object.entries(configured).map(([name, config]) => [name, config.enabled !== false]));
  const db = openReadonlyTimelineDb();
  try {
    return computeSourceFreshness(db, { now, syncEnabled });
  } finally {
    db.close();
  }
}
