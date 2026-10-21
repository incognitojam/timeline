import type { QueryExecutor } from "./pool";

export interface DateActivity {
  date: string;
  eventCount: number;
  sources: string[];
  hasLocation: boolean;
}

export interface DateActivityIndexEntry {
  date: string;
  eventCount: number;
}

interface DateActivityRow {
  date: string;
  eventCount: number;
  sources: string;
  hasLocation: number;
}

export const DATE_ACTIVITY_SQL = `
  SELECT
    day AS date,
    SUM(event_count) AS eventCount,
    GROUP_CONCAT(source) AS sources,
    MAX(location_count > 0) AS hasLocation
  FROM event_day_sources
  WHERE range_day >= ? AND range_day <= ? AND source <> 'recall'
  GROUP BY day
  ORDER BY day DESC
`;

export const DATE_ACTIVITY_INDEX_SQL = `
  SELECT
    day AS date,
    SUM(event_count) AS eventCount
  FROM event_day_sources
  WHERE source <> 'recall'
  GROUP BY day
  ORDER BY day DESC
`;

export async function listDateActivity(
  db: QueryExecutor,
  startDate: string,
  endDate: string,
): Promise<DateActivity[]> {
  const rows = await db.query<DateActivityRow>(
    DATE_ACTIVITY_SQL,
    startDate,
    endDate,
  );

  return rows.map((row) => ({
    date: row.date,
    eventCount: row.eventCount,
    sources: [...new Set(row.sources.split(","))].sort(),
    hasLocation: row.hasLocation === 1,
  }));
}

export async function listDateActivityIndex(
  db: QueryExecutor,
): Promise<DateActivityIndexEntry[]> {
  return db.query<DateActivityIndexEntry>(DATE_ACTIVITY_INDEX_SQL);
}
