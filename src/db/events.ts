import { convertLegacyEmoji } from "./emoji";
import type { QueryExecutor } from "./pool";
import type { TimelineEvent } from "./schema";

/**
 * Transform an event to convert legacy emoji in text fields
 */
export function transformEvent(event: TimelineEvent): TimelineEvent {
  return {
    ...event,
    title: convertLegacyEmoji(event.title),
    content: convertLegacyEmoji(event.content),
  };
}

/**
 * Transform an array of events
 */
export function transformEvents(events: TimelineEvent[]): TimelineEvent[] {
  return events.map(transformEvent);
}

export interface SearchOptions {
  query?: string;
  source?: string;
  type?: string;
  startDate?: string;
  endDate?: string;
  chat?: string;  // Filter by conversation/chat title (case-insensitive LIKE match)
  limit?: number;
  cursor?: string;  // Format: "timestamp_id" for pagination
  includeHiddenContacts?: boolean;  // Hidden contacts are excluded unless explicitly included
  sort?: 'asc' | 'desc';  // Explicit sort order (overrides default behavior)
  excludeSources?: string[];  // Exact source names to omit from results
}

function addSourceExclusion(
  conditions: string[],
  params: (string | number)[],
  excludeSources: string[] | undefined
): void {
  if (!excludeSources || excludeSources.length === 0) return;
  conditions.push(`e.source NOT IN (${excludeSources.map(() => "?").join(", ")})`);
  params.push(...excludeSources);
}

const HIDDEN_CLAUSE_TTL_MS = 30_000;

/**
 * Build SQL clause to exclude events involving hidden contacts
 * using the event_people table (much faster than json_each for full-table scans).
 * Returns empty string if no hidden contacts exist.
 * Cached with 30s TTL to avoid repeated COUNT queries.
 */
let hiddenContactsCache: { anyHidden: boolean; expires: number } | null = null;

export async function hasHiddenContacts(db: QueryExecutor): Promise<boolean> {
  const now = Date.now();
  if (hiddenContactsCache && hiddenContactsCache.expires > now) {
    return hiddenContactsCache.anyHidden;
  }

  const hiddenCount = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM contacts WHERE hidden = 1"
  );
  const anyHidden = (hiddenCount?.count ?? 0) > 0;
  hiddenContactsCache = { anyHidden, expires: now + HIDDEN_CLAUSE_TTL_MS };
  return anyHidden;
}

export function hiddenEventIdsSubquery(): string {
  return `
      SELECT DISTINCT ep.event_id
      FROM event_people ep
      JOIN identities i ON ep.person = (i.platform || ':' || i.platform_id)
      JOIN contacts c ON i.contact_id = c.id
      WHERE c.hidden = 1
  `;
}

export function hiddenEventExclusionClause(tableAlias: string = "e"): string {
  return `
    AND ${tableAlias}.id NOT IN (
      ${hiddenEventIdsSubquery()}
    )
  `;
}

export async function buildHiddenEventClause(db: QueryExecutor, tableAlias: string = "e"): Promise<string> {
  return await hasHiddenContacts(db) ? hiddenEventExclusionClause(tableAlias) : "";
}

/**
 * Invalidate the hidden-contact cache.
 * Call when contacts are hidden/unhidden.
 */
export function invalidateHiddenClauseCaches(): void {
  hiddenContactsCache = null;
}

const NULL_TIMESTAMP_CURSOR = "__null";

interface Cursor {
  timestamp: string;
  id: number;
}

interface NullableTimestampCursor {
  timestamp: string | null;
  id: number;
}

/** Parse a timestamp/id cursor. */
export function parseCursor(cursor: string): Cursor | null;
/** Parse a timestamp/id cursor, including the null-timestamp sentinel. */
export function parseCursor(cursor: string, options: { allowNullTimestamp: true }): NullableTimestampCursor | null;
export function parseCursor(
  cursor: string,
  options?: { allowNullTimestamp: true },
): NullableTimestampCursor | null {
  const match = cursor.match(/^(.+)_(\d+)$/);
  if (!match) return null;
  const id = Number(match[2]);
  if (!Number.isSafeInteger(id)) return null;
  if (options?.allowNullTimestamp && match[1] === NULL_TIMESTAMP_CURSOR) {
    return { timestamp: null, id };
  }
  return { timestamp: match[1], id };
}

/** Create a cursor from an event. */
export function createCursor(event: TimelineEvent): string | null;
/** Create a cursor that can represent a null timestamp with the shared sentinel. */
export function createCursor(cursor: NullableTimestampCursor, options: { allowNullTimestamp: true }): string;
export function createCursor(
  cursor: NullableTimestampCursor,
  options?: { allowNullTimestamp: true },
): string | null {
  if (cursor.timestamp === null) {
    return options?.allowNullTimestamp ? `${NULL_TIMESTAMP_CURSOR}_${cursor.id}` : null;
  }
  return `${cursor.timestamp}_${cursor.id}`;
}

function isQuotedExactQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 2) return false;
  return (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  );
}

function stripExactQueryQuotes(query: string): string {
  const trimmed = query.trim();
  return isQuotedExactQuery(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function buildFtsPrefixQuery(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" ");
}

function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

function addExactLikeSearch(
  conditions: string[],
  params: (string | number)[],
  query: string,
  tableAlias: string,
): void {
  conditions.push(`(
    ${tableAlias}.title LIKE ? ESCAPE '\\' OR ${tableAlias}.title LIKE ? ESCAPE '\\' OR ${tableAlias}.title LIKE ? ESCAPE '\\' OR
    ${tableAlias}.content LIKE ? ESCAPE '\\' OR ${tableAlias}.content LIKE ? ESCAPE '\\' OR ${tableAlias}.content LIKE ? ESCAPE '\\'
  )`);
  const escaped = escapeLikePattern(query);
  params.push(
    `${escaped}%`,      // start of title
    `% ${escaped}%`,    // after space in title
    `%\n${escaped}%`,   // after newline in title
    `${escaped}%`,      // start of content
    `% ${escaped}%`,    // after space in content
    `%\n${escaped}%`    // after newline in content
  );
}

export function addTextSearch(
  conditions: string[],
  params: (string | number)[],
  query: string,
  tableAlias = "e",
): void {
  const exactQuery = isQuotedExactQuery(query);
  const cleanQuery = stripExactQueryQuotes(query);
  const ftsQuery = buildFtsPrefixQuery(cleanQuery);

  if (ftsQuery) {
    conditions.push(`${tableAlias}.id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)`);
    params.push(ftsQuery);
    if (exactQuery) {
      addExactLikeSearch(conditions, params, cleanQuery, tableAlias);
    }
  } else if (cleanQuery.length > 0) {
    addExactLikeSearch(conditions, params, cleanQuery, tableAlias);
  } else {
    conditions.push("0 = 1");
  }
}

export interface SourceStats {
  source: string;
  type: string;
  count: number;
}

export interface SummaryStats {
  source: string;
  type: string;
  count: number;
  sample_titles: string[];
  /** For message types, breakdown by conversation */
  conversations?: { name: string; count: number }[];
}

/**
 * Full-text search across events
 */
export async function searchTimeline(db: QueryExecutor, options: SearchOptions): Promise<TimelineEvent[]> {
  const { query, source, type, startDate, endDate, chat, limit = 50, cursor, includeHiddenContacts = false, sort, excludeSources } = options;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query) {
    addTextSearch(conditions, params, query);
  }

  if (source) {
    // Handle comma-separated sources
    const sources = source.split(',').map(s => s.trim()).filter(Boolean);
    if (sources.length === 1) {
      conditions.push(`e.source = ?`);
      params.push(sources[0]);
    } else if (sources.length > 1) {
      conditions.push(`e.source IN (${sources.map(() => '?').join(', ')})`);
      params.push(...sources);
    }
  }

  if (type) {
    // Handle comma-separated types
    const types = type.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length === 1) {
      conditions.push(`e.type LIKE ?`);
      params.push(types[0] + '%');
    } else if (types.length > 1) {
      conditions.push(`(${types.map(() => 'e.type LIKE ?').join(' OR ')})`);
      params.push(...types.map(t => t + '%'));
    }
  }

  addSourceExclusion(conditions, params, excludeSources);

  if (startDate) {
    conditions.push(`e.timestamp >= ?`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`e.timestamp <= ?`);
    // If endDate is just a date (YYYY-MM-DD), compare to end of day
    if (endDate.length === 10) {
      params.push(endDate + "T23:59:59.999Z");
    } else {
      params.push(endDate);
    }
  }

  if (chat) {
    // Only match conversational events (messages + phone) with matching title
    conditions.push(`e.title LIKE ? AND (e.type LIKE '%message%' OR e.source = 'phone')`);
    params.push(`%${chat}%`);
  }

  // Use explicit sort if provided, otherwise: ASC for date range (chronological), DESC otherwise (recent first)
  const sortOrder = sort === 'asc' ? "ASC" : sort === 'desc' ? "DESC" : (startDate || endDate) ? "ASC" : "DESC";

  // Cursor-based pagination
  if (cursor) {
    const parsed = parseCursor(cursor);
    if (parsed) {
      if (sortOrder === "DESC") {
        // For DESC, get events before the cursor (older)
        conditions.push(`(e.timestamp < ? OR (e.timestamp = ? AND e.id < ?))`);
        params.push(parsed.timestamp, parsed.timestamp, parsed.id);
      } else {
        // For ASC, get events after the cursor (newer)
        conditions.push(`(e.timestamp > ? OR (e.timestamp = ? AND e.id > ?))`);
        params.push(parsed.timestamp, parsed.timestamp, parsed.id);
      }
    }
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const hiddenClause = includeHiddenContacts ? "" : await buildHiddenEventClause(db, "e");

  const sql = `
    SELECT * FROM events e
    WHERE 1=1
    ${whereClause}
    ${hiddenClause}
    ORDER BY e.timestamp ${sortOrder}, e.id ${sortOrder}
    LIMIT ?
  `;
  params.push(limit);

  return transformEvents(await db.query<TimelineEvent>(sql, ...params));
}

/**
 * Get events within a time range
 */
export async function getEvents(
  db: QueryExecutor,
  options: { date?: string; startDate?: string; endDate?: string; source?: string; type?: string; limit?: number; includeHiddenContacts?: boolean }
): Promise<TimelineEvent[]> {
  const { date, startDate, endDate, source, type, limit = 100, includeHiddenContacts = false } = options;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (date) {
    // Single date: use range query for index efficiency (date() function prevents index use)
    conditions.push(`timestamp >= ? AND timestamp < ?`);
    params.push(date + "T00:00:00", date + "T24:00:00");
  } else {
    if (startDate) {
      conditions.push(`timestamp >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`timestamp <= ?`);
      // If endDate is just a date (YYYY-MM-DD), compare to end of day
      if (endDate.length === 10) {
        params.push(endDate + "T23:59:59.999Z");
      } else {
        params.push(endDate);
      }
    }
  }

  if (source) {
    conditions.push(`source = ?`);
    params.push(source);
  }

  if (type) {
    conditions.push(`type LIKE ?`);
    params.push(type + '%');
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const hiddenClause = includeHiddenContacts ? "" : await buildHiddenEventClause(db, "e");

  // ASC when browsing a specific date/range (chronological), DESC otherwise
  const sortOrder = (date || startDate || endDate) ? "ASC" : "DESC";

  const sql = `
    SELECT * FROM events e
    WHERE 1=1
    ${whereClause}
    ${hiddenClause}
    ORDER BY timestamp ${sortOrder}
    LIMIT ?
  `;
  params.push(limit);

  return transformEvents(await db.query<TimelineEvent>(sql, ...params));
}

/**
 * Get events surrounding a specific event or timestamp
 */
export async function getEventContext(
  db: QueryExecutor,
  options: {
    eventId?: number;
    timestamp?: string;
    hoursWindow?: number;
    limit?: number;
    sources?: string[];
    excludeSources?: string[];
  }
): Promise<TimelineEvent[]> {
  const { eventId, timestamp, hoursWindow = 2, limit = 50, sources, excludeSources } = options;

  let centerTimestamp = timestamp;

  if (eventId && !timestamp) {
    const event = await db.get<{ timestamp: string }>(`SELECT timestamp FROM events WHERE id = ?`, eventId);
    if (!event?.timestamp) return [];
    centerTimestamp = event.timestamp;
  }

  if (!centerTimestamp) return [];

  // Compute start/end timestamps in JS to avoid datetime() which prevents index use
  const center = new Date(centerTimestamp);
  const startTs = new Date(center.getTime() - hoursWindow * 60 * 60 * 1000).toISOString();
  const endTs = new Date(center.getTime() + hoursWindow * 60 * 60 * 1000).toISOString();

  const conditions = ["timestamp >= ?", "timestamp < ?"];
  const params: (string | number)[] = [startTs, endTs];

  if (sources && sources.length > 0) {
    conditions.push(`source IN (${sources.map(() => "?").join(", ")})`);
    params.push(...sources);
  }
  if (excludeSources && excludeSources.length > 0) {
    conditions.push(`source NOT IN (${excludeSources.map(() => "?").join(", ")})`);
    params.push(...excludeSources);
  }

  const sql = `
    SELECT * FROM events
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp
    LIMIT ?
  `;
  params.push(limit);

  return transformEvents(await db.query<TimelineEvent>(sql, ...params));
}

export interface DayContextResult {
  date: string;  // YYYY-MM-DD
  centerTimestamp: string;
  events: TimelineEvent[];
  summary: {
    totalEvents: number;
    bySource: { source: string; count: number }[];
    byType: { type: string; count: number }[];
    timeRange: { earliest: string | null; latest: string | null };
  };
}

/**
 * Get all events for a day around a specific timestamp, with summary stats
 */
export async function getDayContext(
  db: QueryExecutor,
  options: { eventId?: number; timestamp?: string; date?: string }
): Promise<DayContextResult | null> {
  const { eventId, timestamp, date } = options;

  let targetDate = date;
  let centerTimestamp = timestamp;

  // Get timestamp from event if provided
  if (eventId && !timestamp) {
    const event = await db.get<{ timestamp: string }>(`SELECT timestamp FROM events WHERE id = ?`, eventId);
    if (!event?.timestamp) return null;
    centerTimestamp = event.timestamp;
  }

  // Extract date from timestamp if not provided
  if (!targetDate && centerTimestamp) {
    targetDate = centerTimestamp.slice(0, 10);  // YYYY-MM-DD
  }

  if (!targetDate) return null;
  if (!centerTimestamp) centerTimestamp = targetDate + "T12:00:00Z";

  // Use range queries for index efficiency (date() function prevents index use)
  const dayStart = targetDate + "T00:00:00";
  const dayEnd = targetDate + "T24:00:00";
  const hiddenClause = await buildHiddenEventClause(db, "e");

  // Get all events for the day
  const events = transformEvents(await db.query<TimelineEvent>(`
    SELECT * FROM events e
    WHERE e.timestamp >= ? AND e.timestamp < ?
    ${hiddenClause}
    ORDER BY e.timestamp ASC
  `, dayStart, dayEnd));

  // Compute summary stats from the already-fetched events (avoids 3 extra DB queries)
  const sourceCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const event of events) {
    sourceCounts.set(event.source, (sourceCounts.get(event.source) || 0) + 1);
    typeCounts.set(event.type, (typeCounts.get(event.type) || 0) + 1);
  }

  const bySource = Array.from(sourceCounts, ([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
  const byType = Array.from(typeCounts, ([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  const timeRange = {
    earliest: events.length > 0 ? events[0].timestamp : null,
    latest: events.length > 0 ? events[events.length - 1].timestamp : null,
  };

  return {
    date: targetDate,
    centerTimestamp,
    events,
    summary: {
      totalEvents: events.length,
      bySource,
      byType,
      timeRange,
    },
  };
}

/**
 * Get most recent events
 */
export async function getRecentEvents(
  db: QueryExecutor,
  options: {
    source?: string;
    type?: string;
    limit?: number;
    cursor?: string;
    includeHiddenContacts?: boolean;
    excludeSources?: string[];
  }
): Promise<TimelineEvent[]> {
  const { source, type, limit = 20, cursor, includeHiddenContacts = false, excludeSources } = options;

  const conditions: string[] = ["e.timestamp IS NOT NULL"];
  const params: (string | number)[] = [];

  if (source) {
    // Handle comma-separated sources
    const sources = source.split(',').map(s => s.trim()).filter(Boolean);
    if (sources.length === 1) {
      conditions.push(`e.source = ?`);
      params.push(sources[0]);
    } else if (sources.length > 1) {
      conditions.push(`e.source IN (${sources.map(() => '?').join(', ')})`);
      params.push(...sources);
    }
  }

  if (type) {
    // Handle comma-separated types
    const types = type.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length === 1) {
      conditions.push(`e.type LIKE ?`);
      params.push(types[0] + '%');
    } else if (types.length > 1) {
      conditions.push(`(${types.map(() => 'e.type LIKE ?').join(' OR ')})`);
      params.push(...types.map(t => t + '%'));
    }
  }

  addSourceExclusion(conditions, params, excludeSources);

  // Cursor-based pagination (always DESC for recent)
  if (cursor) {
    const parsed = parseCursor(cursor);
    if (parsed) {
      conditions.push(`(e.timestamp < ? OR (e.timestamp = ? AND e.id < ?))`);
      params.push(parsed.timestamp, parsed.timestamp, parsed.id);
    }
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const hiddenClause = includeHiddenContacts ? "" : await buildHiddenEventClause(db, "e");

  const sql = `
    SELECT * FROM events e
    ${whereClause}
    ${hiddenClause}
    ORDER BY e.timestamp DESC, e.id DESC
    LIMIT ?
  `;
  params.push(limit);

  return transformEvents(await db.query<TimelineEvent>(sql, ...params));
}

/**
 * Hydrate full event rows from a list of event IDs, preserving the order the IDs
 * were given in (e.g. similarity order from vector search) rather than SQL row
 * order. Duplicate IDs collapse to their first occurrence. IDs with no matching
 * row are dropped and counted in `missingCount` — an index (e.g. embeddings) can
 * outlive the events it references. With `limit`, the cap is applied *after*
 * missing IDs are dropped, so callers still get up to `limit` real events even
 * when some candidates are stale.
 */
export async function hydrateEventsById(
  db: QueryExecutor,
  ids: Iterable<number>,
  options: { limit?: number } = {},
): Promise<{ events: TimelineEvent[]; missingCount: number }> {
  const orderedIds: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }

  if (orderedIds.length === 0) {
    return { events: [], missingCount: 0 };
  }

  const placeholders = orderedIds.map(() => "?").join(", ");
  const rows = await db.query<TimelineEvent>(
    `SELECT * FROM events WHERE id IN (${placeholders})`,
    ...orderedIds,
  );

  const byId = new Map(transformEvents(rows).map((event) => [event.id, event]));
  const hydrated = orderedIds
    .map((id) => byId.get(id))
    .filter((event): event is TimelineEvent => event !== undefined);

  return {
    events: options.limit === undefined ? hydrated : hydrated.slice(0, options.limit),
    missingCount: orderedIds.length - hydrated.length,
  };
}

/**
 * List all sources with event counts by type
 */
export async function listSources(
  db: QueryExecutor,
  options?: { includeHiddenContacts?: boolean }
): Promise<SourceStats[]> {
  const hiddenClause = options?.includeHiddenContacts
    ? ""
    : await buildHiddenEventClause(db, "e");

  const sql = `
    SELECT e.source as source, e.type as type, COUNT(*) as count
    FROM events e
    WHERE 1=1 ${hiddenClause}
    GROUP BY e.source, e.type
    ORDER BY e.source, count DESC
  `;

  return db.query<SourceStats>(sql);
}
