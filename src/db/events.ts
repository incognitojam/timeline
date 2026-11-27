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

/**
 * Continue after `cursor` in a `ORDER BY <timestamp> <order>, <id> <order>`
 * listing, including the untimed rows SQLite sorts first ascending and last
 * descending. A cursor that does not parse adds nothing.
 */
export function addCursorCondition(
  conditions: string[],
  params: (string | number)[],
  cursor: string,
  sortOrder: "ASC" | "DESC",
  timestamp: string,
  id: string,
): void {
  const parsed = parseCursor(cursor, { allowNullTimestamp: true });
  if (!parsed) return;
  const op = sortOrder === "DESC" ? "<" : ">";
  if (parsed.timestamp === null) {
    conditions.push(sortOrder === "DESC"
      ? `(${timestamp} IS NULL AND ${id} < ?)`
      : `((${timestamp} IS NULL AND ${id} > ?) OR ${timestamp} IS NOT NULL)`);
    params.push(parsed.id);
    return;
  }
  const untimed = sortOrder === "DESC" ? ` OR ${timestamp} IS NULL` : "";
  conditions.push(`(${timestamp} ${op} ? OR (${timestamp} = ? AND ${id} ${op} ?)${untimed})`);
  params.push(parsed.timestamp, parsed.timestamp, parsed.id);
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

// Split as the unicode61 tokenizer does, so each token is one indexed word:
// events_fts_stemmed has no positions to match a multi-word phrase.
const FTS_TOKEN = /[\p{L}\p{N}]+/gu;

function ftsTokens(text: string): string[] {
  return text.match(FTS_TOKEN) ?? [];
}

function ftsPhrase(tokens: string[]): string {
  return `"${tokens.join(" ").replace(/"/g, '""')}"`;
}

/**
 * Terms a search must match, split by the index that answers them. Plain
 * words match stemmed (`run` finds "running"); `word*` matches words starting
 * with it; `"quoted words"` match as written, with any punctuation in them
 * checked literally because FTS ignores it.
 */
interface TextMatch {
  stemmed: string[];
  exact: string[];
  literals: string[];
}

/** Terms every result matches, and one TextMatch per `-word` none may match. */
interface TextSearch {
  include: TextMatch;
  exclude: TextMatch[];
}

function emptyTextMatch(): TextMatch {
  return { stemmed: [], exact: [], literals: [] };
}

function isEmptyTextMatch(match: TextMatch): boolean {
  return match.stemmed.length === 0 && match.exact.length === 0 && match.literals.length === 0;
}

function addQuotedTerms(match: TextMatch, quoted: string): void {
  const tokens = ftsTokens(quoted);
  if (tokens.length > 0) match.exact.push(ftsPhrase(tokens));
  const phrase = quoted.trim();
  if (phrase && /[^\p{L}\p{N}\s]/u.test(phrase)) match.literals.push(phrase);
}

function addWordTerms(match: TextMatch, chunk: string): void {
  const tokens = ftsTokens(chunk);
  const last = tokens.pop();
  if (last === undefined) return;
  for (const token of tokens) match.stemmed.push(ftsPhrase([token]));
  if (chunk.endsWith("*")) {
    match.exact.push(`${ftsPhrase([last])}*`);
  } else {
    match.stemmed.push(ftsPhrase([last]));
  }
}

function parseTextSearch(query: string): TextSearch {
  const search: TextSearch = { include: emptyTextMatch(), exclude: [] };
  const trimmed = query.trim();
  // A whole query in single quotes is an exact phrase, like double quotes.
  const normalized = trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
    ? `"${trimmed.slice(1, -1)}"`
    : trimmed;

  // A quote left open while typing runs to the end of the query. A leading
  // "-" excludes the word or quote; one inside a word ("board-games") doesn't.
  for (const match of normalized.matchAll(/(-?)"([^"]*)"?|[^\s"]+/g)) {
    const quoted = match[2];
    const excluded = quoted === undefined ? match[0].startsWith("-") : match[1] === "-";
    const target = excluded ? emptyTextMatch() : search.include;
    if (quoted === undefined) {
      addWordTerms(target, match[0]);
    } else {
      addQuotedTerms(target, quoted);
    }
    if (excluded && !isEmptyTextMatch(target)) search.exclude.push(target);
  }
  return search;
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

function addTextMatch(
  conditions: string[],
  params: (string | number)[],
  match: TextMatch,
  tableAlias: string,
): void {
  if (match.stemmed.length > 0) {
    conditions.push(`${tableAlias}.id IN (SELECT rowid FROM events_fts_stemmed WHERE events_fts_stemmed MATCH ?)`);
    params.push(match.stemmed.join(" "));
  }
  if (match.exact.length > 0) {
    conditions.push(`${tableAlias}.id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)`);
    params.push(match.exact.join(" "));
  }
  for (const literal of match.literals) {
    addExactLikeSearch(conditions, params, literal, tableAlias);
  }
}

export function addTextSearch(
  conditions: string[],
  params: (string | number)[],
  query: string,
  tableAlias = "e",
): void {
  const search = parseTextSearch(query);
  addTextMatch(conditions, params, search.include, tableAlias);

  for (const excluded of search.exclude) {
    const excludedConditions: string[] = [];
    addTextMatch(excludedConditions, params, excluded, tableAlias);
    // LIKE on NULL title and content is NULL, which NOT would leave NULL.
    conditions.push(`NOT COALESCE((${excludedConditions.join(" AND ")}), 0)`);
  }

  if (isEmptyTextMatch(search.include) && search.exclude.length === 0) {
    // Symbols FTS can't index, such as "+", fall back to a literal match.
    const literal = query.replace(/"/g, "").trim();
    if (literal.length > 0) {
      addExactLikeSearch(conditions, params, literal, tableAlias);
    } else {
      conditions.push("0 = 1");
    }
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

/** searchTimeline's filters (not its cursor) as `e.` conditions and their params. */
function searchConditions(
  options: Pick<SearchOptions, "query" | "source" | "type" | "startDate" | "endDate" | "chat" | "excludeSources">,
): { conditions: string[]; params: (string | number)[] } {
  const { query, source, type, startDate, endDate, chat, excludeSources } = options;
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

  return { conditions, params };
}

export interface EventGroup {
  source: string;
  /** Null for a group of events outside any conversation, which are grouped by type. */
  conversation_id: string | null;
  type: string;
  /** The title of the group's newest hit: for a conversation, its name. */
  title: string | null;
  hits: number;
  first: string | null;
  last: string | null;
  /** The group's newest hit. */
  example_id: number;
  /** Groups and hits across every group, not only those returned. */
  groups: number;
  total_hits: number;
}

/**
 * Group the events matching `where` by conversation, or by source and type
 * (across accounts) for events outside one: most hits first, up to `limit` groups.
 */
export async function groupEvents(
  db: QueryExecutor,
  where: string,
  params: (string | number)[],
  limit: number,
): Promise<EventGroup[]> {
  const groups = await db.query<Omit<EventGroup, "title">>(`
    SELECT e.source, e.conversation_id, e.type,
      count(*) AS hits, min(e.timestamp) AS first, max(e.timestamp) AS last,
      CAST(substr(max(coalesce(e.timestamp, '') || printf(' %019d', e.id)), -19) AS INTEGER) AS example_id,
      count(*) OVER () AS groups, sum(count(*)) OVER () AS total_hits
    FROM events e
    WHERE ${where}
    GROUP BY e.source, e.conversation_id IS NULL, coalesce(e.conversation_id, e.type), iif(e.conversation_id IS NULL, NULL, e.source_account)
    ORDER BY hits DESC, last DESC
    LIMIT ?
  `, ...params, limit);
  if (groups.length === 0) return [];
  const titles = new Map((await db.query<{ id: number; title: string | null }>(
    `SELECT id, title FROM events WHERE id IN (${groups.map(() => "?").join(", ")})`,
    ...groups.map((g) => g.example_id),
  )).map((row) => [row.id, row.title]));
  return groups.map((g) => ({ ...g, title: titles.get(g.example_id) ?? null }));
}

/** searchTimeline's matches (ignoring limit, cursor and sort), grouped by groupEvents. */
export async function searchTimelineGroups(
  db: QueryExecutor,
  options: SearchOptions,
  limit: number,
): Promise<EventGroup[]> {
  const { conditions, params } = searchConditions(options);
  const hiddenClause = options.includeHiddenContacts ? "" : await buildHiddenEventClause(db, "e");
  return groupEvents(db, `1=1 ${conditions.map((c) => `AND ${c}`).join(" ")} ${hiddenClause}`, params, limit);
}

/**
 * Full-text search across events
 */
export async function searchTimeline(db: QueryExecutor, options: SearchOptions): Promise<TimelineEvent[]> {
  const { startDate, endDate, limit = 50, cursor, includeHiddenContacts = false, sort } = options;
  const { conditions, params } = searchConditions(options);

  // Use explicit sort if provided, otherwise: ASC for date range (chronological), DESC otherwise (recent first)
  const sortOrder = sort === 'asc' ? "ASC" : sort === 'desc' ? "DESC" : (startDate || endDate) ? "ASC" : "DESC";

  // Cursor-based pagination
  if (cursor) addCursorCondition(conditions, params, cursor, sortOrder, "e.timestamp", "e.id");

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
  options: { date?: string; startDate?: string; endDate?: string; source?: string; type?: string; limit?: number; cursor?: string; includeHiddenContacts?: boolean; excludeSources?: string[] }
): Promise<TimelineEvent[]> {
  const { date, startDate, endDate, source, type, limit = 100, cursor, includeHiddenContacts = false, excludeSources } = options;

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

  addSourceExclusion(conditions, params, excludeSources);

  // ASC when browsing a specific date/range (chronological), DESC otherwise
  const sortOrder = (date || startDate || endDate) ? "ASC" : "DESC";

  const parsedCursor = cursor ? parseCursor(cursor) : null;
  if (parsedCursor) {
    const op = sortOrder === "DESC" ? "<" : ">";
    conditions.push(`(timestamp ${op} ? OR (timestamp = ? AND id ${op} ?))`);
    params.push(parsedCursor.timestamp, parsedCursor.timestamp, parsedCursor.id);
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
  const hiddenClause = includeHiddenContacts ? "" : await buildHiddenEventClause(db, "e");

  const sql = `
    SELECT * FROM events e
    WHERE 1=1
    ${whereClause}
    ${hiddenClause}
    ORDER BY timestamp ${sortOrder}, id ${sortOrder}
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
    /** Continue after this event (a createCursor value from the previous page). */
    cursor?: string;
    sources?: string[];
    excludeSources?: string[];
  }
): Promise<TimelineEvent[]> {
  const { eventId, timestamp, hoursWindow = 2, limit = 50, cursor, sources, excludeSources } = options;

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
  const parsedCursor = cursor ? parseCursor(cursor) : null;
  if (parsedCursor) {
    conditions.push("(timestamp > ? OR (timestamp = ? AND id > ?))");
    params.push(parsedCursor.timestamp, parsedCursor.timestamp, parsedCursor.id);
  }

  const sql = `
    SELECT * FROM events
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp, id
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
