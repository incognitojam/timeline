import type { QueryExecutor } from "./pool";
import type { TimelineEvent } from "./schema";
import { parseCursor, createCursor, transformEvents } from "./events";

export interface WakaTimeStatsOptions {
  startDate?: string;
  endDate?: string;
  preset?: "today" | "yesterday" | "7d" | "30d" | "year" | "all";
}

export interface WakaTimeStats {
  totalDuration: number;
  sessionCount: number;
  avgSessionDuration: number;
  dateRange: { start: string | null; end: string | null };
  byProject: Array<{ name: string; duration: number; sessionCount: number }>;
  byLanguage: Array<{ name: string; duration: number }>;
  byBranch: Array<{ name: string; duration: number }>;
  byDay: Array<{ date: string; duration: number }>;
}

/**
 * Convert a preset to date range
 */
function presetToDateRange(preset: string): { startDate: string; endDate: string } {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  switch (preset) {
    case "today":
      return { startDate: today, endDate: today };
    case "yesterday": {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yd = yesterday.toISOString().slice(0, 10);
      return { startDate: yd, endDate: yd };
    }
    case "7d": {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return { startDate: weekAgo.toISOString().slice(0, 10), endDate: today };
    }
    case "30d": {
      const monthAgo = new Date(now);
      monthAgo.setDate(monthAgo.getDate() - 30);
      return { startDate: monthAgo.toISOString().slice(0, 10), endDate: today };
    }
    case "year": {
      const yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      return { startDate: yearAgo.toISOString().slice(0, 10), endDate: today };
    }
    default:
      return { startDate: "", endDate: "" };
  }
}

/**
 * Extract project name from WakaTime session title
 * Title format: "ProjectName (Language)" or just "ProjectName"
 */
function extractProjectName(title: string | null): string {
  if (!title) return "Unknown";
  const match = title.match(/^(.+?)\s*\(/);
  return match ? match[1] : title;
}

/**
 * Get WakaTime stats for a date range
 */
export async function getWakaTimeStats(db: QueryExecutor, options: WakaTimeStatsOptions = {}): Promise<WakaTimeStats> {
  let { startDate, endDate } = options;

  // Convert preset to date range
  if (options.preset && options.preset !== "all") {
    const range = presetToDateRange(options.preset);
    startDate = range.startDate;
    endDate = range.endDate;
  }

  // Build date conditions
  const conditions: string[] = ["source = 'wakatime'", "type = 'code:session'"];
  const params: string[] = [];

  if (startDate) {
    conditions.push("timestamp >= ?");
    params.push(startDate + "T00:00:00");
  }
  if (endDate) {
    conditions.push("timestamp < ?");
    params.push(endDate + "T24:00:00");
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  // Total stats
  const totals = await db.get<{
    total_duration: number;
    session_count: number;
    avg_duration: number;
    first_session: string | null;
    last_session: string | null;
  }>(`
    SELECT
      COALESCE(SUM(duration_ms), 0) as total_duration,
      COUNT(*) as session_count,
      COALESCE(AVG(duration_ms), 0) as avg_duration,
      MIN(timestamp) as first_session,
      MAX(timestamp) as last_session
    FROM events
    ${whereClause}
  `, ...params);

  // By project (extract from title)
  const byProject = await db.query<{ name: string; duration: number; sessionCount: number }>(`
    SELECT
      CASE
        WHEN INSTR(title, ' (') > 0 THEN SUBSTR(title, 1, INSTR(title, ' (') - 1)
        ELSE title
      END as name,
      COALESCE(SUM(duration_ms), 0) as duration,
      COUNT(*) as sessionCount
    FROM events
    ${whereClause}
    GROUP BY name
    ORDER BY duration DESC
    LIMIT 50
  `, ...params);

  // Qualified where clause for json_each joins (json_each has its own 'type'
  // column that collides with events.type).
  const qualifiedWhereClause = whereClause
    .replace(/\bsource\b/g, "e.source")
    .replace(/\btype\b/g, "e.type")
    .replace(/\btimestamp\b/g, "e.timestamp");

  // By language: apportion each session's duration across its detected
  // languages by heartbeat count, so multi-language sessions don't get
  // counted N times. `raw_data.languages` is the per-session frequency map
  // built by the parser; `tags` is only the distinct-value listing.
  const byLanguage = await db.query<{ name: string; duration: number }>(`
    SELECT
      l.key as name,
      COALESCE(SUM(
        CAST(l.value AS REAL)
        / (SELECT SUM(CAST(value AS REAL)) FROM json_each(json_extract(e.raw_data, '$.languages')))
        * COALESCE(e.duration_ms, 0)
      ), 0) as duration
    FROM events e, json_each(json_extract(e.raw_data, '$.languages')) l
    ${qualifiedWhereClause}
    GROUP BY name
    ORDER BY duration DESC
    LIMIT 20
  `, ...params);

  // By branch (from raw_data.branches)
  const byBranch = await db.query<{ name: string; duration: number }>(`
    SELECT
      b.value as name,
      COALESCE(SUM(e.duration_ms), 0) as duration
    FROM events e, json_each(json_extract(e.raw_data, '$.branches')) b
    ${qualifiedWhereClause}
    GROUP BY b.value
    ORDER BY duration DESC
    LIMIT 20
  `, ...params);

  // Daily activity
  const byDay = await db.query<{ date: string; duration: number }>(`
    SELECT
      DATE(timestamp) as date,
      COALESCE(SUM(duration_ms), 0) as duration
    FROM events
    ${whereClause}
    GROUP BY date
    ORDER BY date
  `, ...params);

  return {
    totalDuration: totals?.total_duration ?? 0,
    sessionCount: totals?.session_count ?? 0,
    avgSessionDuration: Math.round(totals?.avg_duration ?? 0),
    dateRange: {
      start: totals?.first_session?.slice(0, 10) ?? null,
      end: totals?.last_session?.slice(0, 10) ?? null
    },
    byProject,
    byLanguage,
    byBranch,
    byDay,
  };
}

export interface WakaTimeProjectStats {
  project: {
    name: string;
    totalDuration: number;
    sessionCount: number;
    firstActivity: string | null;
    lastActivity: string | null;
  };
  byLanguage: Array<{ name: string; duration: number }>;
  byBranch: Array<{ name: string; duration: number }>;
  byDay: Array<{ date: string; duration: number }>;
  activityByMonth: Array<{ month: string; duration: number }>;
}

/**
 * Get detailed stats for a specific WakaTime project
 */
export async function getWakaTimeProject(
  db: QueryExecutor,
  projectName: string,
  options: { startDate?: string; endDate?: string } = {}
): Promise<WakaTimeProjectStats | null> {
  const { startDate, endDate } = options;

  // Match sessions where title starts with the project name
  const conditions: string[] = [
    "source = 'wakatime'",
    "type = 'code:session'",
    "(title = ? OR title LIKE ?)",  // Exact match or "Project (Language)" format
  ];
  const params: (string | number)[] = [projectName, `${projectName} (%`];

  if (startDate) {
    conditions.push("timestamp >= ?");
    params.push(startDate + "T00:00:00");
  }
  if (endDate) {
    conditions.push("timestamp < ?");
    params.push(endDate + "T24:00:00");
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  // Basic project stats
  const projectStats = await db.get<{
    totalDuration: number;
    sessionCount: number;
    firstActivity: string | null;
    lastActivity: string | null;
  }>(`
    SELECT
      COALESCE(SUM(duration_ms), 0) as totalDuration,
      COUNT(*) as sessionCount,
      MIN(timestamp) as firstActivity,
      MAX(timestamp) as lastActivity
    FROM events
    ${whereClause}
  `, ...params);

  if (!projectStats || projectStats.sessionCount === 0) {
    return null;
  }

  // Qualified where clause for json_each joins (json_each exposes its own
  // 'type' column that collides with events.type).
  const qualifiedWhereClause = whereClause
    .replace(/\bsource\b/g, "e.source")
    .replace(/\btype\b/g, "e.type")
    .replace(/\btimestamp\b/g, "e.timestamp")
    .replace(/\btitle\b/g, "e.title");

  // By language: apportion each session's duration across its detected
  // languages by heartbeat count, so multi-language sessions don't get
  // counted N times. `raw_data.languages` is the per-session frequency map
  // built by the parser; `tags` is only the distinct-value listing.
  const byLanguage = await db.query<{ name: string; duration: number }>(`
    SELECT
      l.key as name,
      COALESCE(SUM(
        CAST(l.value AS REAL)
        / (SELECT SUM(CAST(value AS REAL)) FROM json_each(json_extract(e.raw_data, '$.languages')))
        * COALESCE(e.duration_ms, 0)
      ), 0) as duration
    FROM events e, json_each(json_extract(e.raw_data, '$.languages')) l
    ${qualifiedWhereClause}
    GROUP BY name
    ORDER BY duration DESC
    LIMIT 20
  `, ...params);

  // By branch (from raw_data.branches)
  const byBranch = await db.query<{ name: string; duration: number }>(`
    SELECT
      b.value as name,
      COALESCE(SUM(e.duration_ms), 0) as duration
    FROM events e, json_each(json_extract(e.raw_data, '$.branches')) b
    ${qualifiedWhereClause}
    GROUP BY b.value
    ORDER BY duration DESC
    LIMIT 20
  `, ...params);

  // Daily activity
  const byDay = await db.query<{ date: string; duration: number }>(`
    SELECT
      DATE(timestamp) as date,
      COALESCE(SUM(duration_ms), 0) as duration
    FROM events
    ${whereClause}
    GROUP BY date
    ORDER BY date
  `, ...params);

  // Activity by month
  const activityByMonth = await db.query<{ month: string; duration: number }>(`
    SELECT
      strftime('%Y-%m', timestamp) as month,
      COALESCE(SUM(duration_ms), 0) as duration
    FROM events
    ${whereClause}
    GROUP BY month
    ORDER BY month
  `, ...params);

  return {
    project: {
      name: projectName,
      ...projectStats,
    },
    byLanguage,
    byBranch,
    byDay,
    activityByMonth,
  };
}

/**
 * Get sessions for a specific WakaTime project with pagination
 */
export async function getWakaTimeProjectSessions(
  db: QueryExecutor,
  projectName: string,
  options: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    cursor?: string;
    order?: "asc" | "desc";
  } = {}
): Promise<{ sessions: TimelineEvent[]; count: number; nextCursor: string | null }> {
  const { startDate, endDate, limit = 50, cursor, order = "desc" } = options;

  const conditions: string[] = [
    "source = 'wakatime'",
    "type = 'code:session'",
    "(title = ? OR title LIKE ?)",
  ];
  const params: (string | number)[] = [projectName, `${projectName} (%`];

  if (startDate) {
    conditions.push("timestamp >= ?");
    params.push(startDate + "T00:00:00");
  }
  if (endDate) {
    conditions.push("timestamp < ?");
    params.push(endDate + "T24:00:00");
  }

  if (cursor) {
    const parsed = parseCursor(cursor);
    if (parsed) {
      if (order === "desc") {
        conditions.push("(timestamp < ? OR (timestamp = ? AND id < ?))");
      } else {
        conditions.push("(timestamp > ? OR (timestamp = ? AND id > ?))");
      }
      params.push(parsed.timestamp, parsed.timestamp, parsed.id);
    }
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const sortDir = order === "desc" ? "DESC" : "ASC";

  // Simpler count query
  const countResult = await db.get<{ count: number }>(`
    SELECT COUNT(*) as count FROM events
    WHERE source = 'wakatime' AND type = 'code:session'
      AND (title = ? OR title LIKE ?)
  `, projectName, `${projectName} (%`);
  if (!countResult) throw new Error("COUNT query returned no result");

  // Get sessions
  const sessions = await db.query<TimelineEvent>(`
    SELECT * FROM events
    ${whereClause}
    ORDER BY timestamp ${sortDir}, id ${sortDir}
    LIMIT ?
  `, ...params, limit + 1);

  const hasMore = sessions.length > limit;
  if (hasMore) sessions.pop();

  const nextCursor = hasMore && sessions.length > 0
    ? createCursor(sessions[sessions.length - 1])
    : null;

  return {
    sessions: transformEvents(sessions),
    count: countResult.count,
    nextCursor,
  };
}
