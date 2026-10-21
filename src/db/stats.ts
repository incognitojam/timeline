import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { wrapDatabase, type QueryExecutor } from "./pool";
import { setCache } from "./cache";
import { conversationTypeClause } from "./conversations";
import { hiddenEventIdsSubquery } from "./events";
import type { SourceStats, SummaryStats } from "./events";

/**
 * Get overall stats
 */
interface StatsResult {
  total_events: number;
  sources: SourceStats[];
  date_range: { earliest: string | null; latest: string | null };
}

type StatsRow =
  | {
    row_kind: 0;
    source: null;
    type: null;
    count: number;
    earliest: string | null;
    latest: string | null;
  }
  | {
    row_kind: 1;
    source: string;
    type: string;
    count: number;
    earliest: null;
    latest: null;
  };

async function computeStats(db: QueryExecutor): Promise<StatsResult> {
  const rows = await db.query<StatsRow>(`
    WITH
      hidden_events AS MATERIALIZED (
        ${hiddenEventIdsSubquery()}
      ),
      hidden_sources AS MATERIALIZED (
        SELECT e.source, e.type, COUNT(*) AS count
        FROM hidden_events hidden
        CROSS JOIN events e
        WHERE e.id = hidden.event_id
        GROUP BY e.source, e.type
      ),
      visible_sources AS MATERIALIZED (
        SELECT
          totals.source,
          totals.type,
          COUNT(*) - COALESCE(MAX(hidden.count), 0) AS count
        FROM events totals
        LEFT JOIN hidden_sources hidden
          ON hidden.source = totals.source AND hidden.type = totals.type
        GROUP BY totals.source, totals.type
        HAVING COUNT(*) - COALESCE(MAX(hidden.count), 0) > 0
      )
    SELECT
      0 AS row_kind,
      NULL AS source,
      NULL AS type,
      (SELECT COALESCE(SUM(count), 0) FROM visible_sources) AS count,
      (
        SELECT e.timestamp
        FROM events e
        WHERE e.timestamp IS NOT NULL
          AND e.id NOT IN (SELECT event_id FROM hidden_events)
        ORDER BY e.timestamp ASC
        LIMIT 1
      ) AS earliest,
      (
        SELECT e.timestamp
        FROM events e
        WHERE e.timestamp IS NOT NULL
          AND e.id NOT IN (SELECT event_id FROM hidden_events)
        ORDER BY e.timestamp DESC
        LIMIT 1
      ) AS latest
    UNION ALL
    SELECT 1, source, type, count, NULL, NULL
    FROM visible_sources
    ORDER BY row_kind, source, count DESC
  `);

  const summary = rows.find((row): row is Extract<StatsRow, { row_kind: 0 }> => row.row_kind === 0);
  if (!summary) throw new Error("Stats query returned no summary row");

  const sources: SourceStats[] = rows
    .filter((row): row is Extract<StatsRow, { row_kind: 1 }> => row.row_kind === 1)
    .map(({ source, type, count }) => ({ source, type, count }));

  return {
    total_events: summary.count,
    sources,
    date_range: {
      earliest: summary.earliest,
      latest: summary.latest,
    },
  };
}

const STATS_CACHE_KEY = "stats";

interface StatsCacheTombstone {
  invalidated: string;
}

function parseStatsCache(value: string): StatsResult | null {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Stats cache value must be an object");
  }

  if ("invalidated" in parsed) {
    if (typeof parsed.invalidated !== "string") {
      throw new Error("Stats cache invalidation token must be a string");
    }
    return null;
  }
  return parsed as StatsResult;
}

function setStatsCacheIfCurrent(
  db: Database,
  stats: StatsResult,
  expectedValue: string | null,
): void {
  db.prepare(`
    INSERT INTO cache (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    WHERE ? IS NOT NULL AND cache.value = ?
  `).run(STATS_CACHE_KEY, JSON.stringify(stats), expectedValue, expectedValue);
}

/**
 * Invalidate the stats cache so it recomputes on next request
 */
export function invalidateStatsCache(db: Database): void {
  setCache(db, STATS_CACHE_KEY, {
    invalidated: randomUUID(),
  } satisfies StatsCacheTombstone);
}

export async function getStats(db: QueryExecutor, writeDb?: Database): Promise<StatsResult> {
  const cached = await db.get<{ value: string }>(
    "SELECT value FROM cache WHERE key = ?", STATS_CACHE_KEY
  );
  const expectedValue = cached?.value ?? null;
  if (cached) {
    const stats = parseStatsCache(cached.value);
    if (stats) return stats;
  }

  const stats = await computeStats(db);

  if (writeDb) {
    setStatsCacheIfCurrent(writeDb, stats, expectedValue);
  }

  return stats;
}

export async function refreshStatsCache(db: Database): Promise<StatsResult> {
  const cached = db.prepare("SELECT value FROM cache WHERE key = ?").get(STATS_CACHE_KEY) as {
    value: string;
  } | undefined;
  const stats = await computeStats(wrapDatabase(db));
  setStatsCacheIfCurrent(db, stats, cached?.value ?? null);
  return stats;
}

/**
 * Get aggregated summary for a time period
 */
export async function getSummary(
  db: QueryExecutor,
  options: {
    date?: string;
    startDate?: string;
    endDate?: string;
    sources?: string[];
    excludeSources?: string[];
  }
): Promise<SummaryStats[]> {
  const { date, startDate, endDate, sources, excludeSources } = options;

  const conditions: string[] = [];
  const params: string[] = [];

  if (date) {
    // Use range query for index efficiency (date() function prevents index use)
    conditions.push(`timestamp >= ? AND timestamp < ?`);
    params.push(date + "T00:00:00", date + "T24:00:00");
  } else {
    if (startDate) {
      conditions.push(`timestamp >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`timestamp <= ?`);
      params.push(endDate);
    }
  }

  if (sources && sources.length > 0) {
    conditions.push(`source IN (${sources.map(() => "?").join(", ")})`);
    params.push(...sources);
  }
  if (excludeSources && excludeSources.length > 0) {
    conditions.push(`source NOT IN (${excludeSources.map(() => "?").join(", ")})`);
    params.push(...excludeSources);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get counts and sample titles per source/type
  const sql = `
    SELECT
      source,
      type,
      COUNT(*) as count,
      json_group_array(title) as all_titles
    FROM events
    ${whereClause}
    GROUP BY source, type
    ORDER BY count DESC
  `;

  const rows = await db.query<{
    source: string;
    type: string;
    count: number;
    all_titles: string;
  }>(sql, ...params);

  // For message types, get per-conversation breakdown
  const conversationSql = `
    SELECT source, type, title as conversation, COUNT(*) as count
    FROM events
    ${whereClause}
    ${conditions.length > 0 ? "AND" : "WHERE"} ${conversationTypeClause()} AND title IS NOT NULL
    GROUP BY source, type, title
    ORDER BY source, type, count DESC
  `;
  const conversationRows = await db.query<{
    source: string;
    type: string;
    conversation: string;
    count: number;
  }>(conversationSql, ...params);

  // Index conversations by source+type
  const conversationMap = new Map<string, { name: string; count: number }[]>();
  for (const row of conversationRows) {
    const key = `${row.source}:${row.type}`;
    let convs = conversationMap.get(key);
    if (!convs) {
      convs = [];
      conversationMap.set(key, convs);
    }
    convs.push({ name: row.conversation, count: row.count });
  }

  return rows.map((row) => {
    const allTitles = JSON.parse(row.all_titles) as (string | null)[];
    // Get unique non-null titles, limit to 5 samples
    const uniqueTitles = [...new Set(allTitles.filter((t): t is string => t !== null))].slice(0, 5);

    const result: SummaryStats = {
      source: row.source,
      type: row.type,
      count: row.count,
      sample_titles: uniqueTitles,
    };

    // Add conversation breakdown for message types
    const key = `${row.source}:${row.type}`;
    if (row.type.startsWith("message") && conversationMap.has(key)) {
      result.conversations = conversationMap.get(key);
    }

    return result;
  });
}
