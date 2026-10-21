import { Database } from "bun:sqlite";
import type { QueryExecutor } from "./pool";
import type { TimelineEvent, Contact, ContactAlias, Platform } from "./schema";
import { isValidPlatform } from "./schema";
import { conversationTypeClause } from "./conversations";
import { addTextSearch, transformEvents, parseCursor, createCursor } from "./events";
import type { SearchOptions } from "./events";
import { parseIdentifier, formatIdentifier, getIdentitiesForContact } from "./identities";
import { PHONE_IDENTITY_PLATFORM, PHONE_IDENTITY_SOURCES } from "../lib/phone";

/**
 * Create a new contact
 */
export function createContact(
  db: Database,
  displayName: string,
  notes?: string
): number {
  const result = db.prepare(`
    INSERT INTO contacts (display_name, notes)
    VALUES (?, ?)
  `).run(displayName, notes ?? null);
  return Number(result.lastInsertRowid);
}

/**
 * Update an existing contact
 */
export function updateContact(
  db: Database,
  id: number,
  updates: {
    displayName?: string;
    notes?: string;
    hidden?: boolean;
    dateOfBirth?: string | null;
    isSelf?: boolean;
  }
): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: (string | number | null)[] = [];

  if (updates.displayName !== undefined) {
    sets.push("display_name = ?");
    params.push(updates.displayName);
  }
  if (updates.notes !== undefined) {
    sets.push("notes = ?");
    params.push(updates.notes);
  }
  if (updates.hidden !== undefined) {
    sets.push("hidden = ?");
    params.push(updates.hidden ? 1 : 0);
  }
  if (updates.dateOfBirth !== undefined) {
    sets.push("date_of_birth = ?");
    params.push(updates.dateOfBirth);
  }
  if (updates.isSelf !== undefined) {
    sets.push("is_self = ?");
    params.push(updates.isSelf ? 1 : 0);
  }

  params.push(id);
  const applyUpdates = db.transaction(() => {
    if (updates.isSelf) {
      db.prepare(
        "UPDATE contacts SET is_self = 0, updated_at = datetime('now') WHERE is_self = 1 AND id != ?"
      ).run(id);
    }
    db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  });
  applyUpdates();
}

/**
 * Delete a contact and its associated data.
 * Manual cascade since PRAGMA foreign_keys is not enabled on the main DB.
 */
export function deleteContact(db: Database, id: number): void {
  db.prepare("DELETE FROM contact_memories WHERE contact_id = ?").run(id);
  db.prepare("UPDATE identities SET contact_id = NULL WHERE contact_id = ?").run(id);
  db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
}

/**
 * Get a contact by ID
 */
export async function getContact(db: QueryExecutor, id: number): Promise<Contact | null> {
  return await db.get<Contact>("SELECT * FROM contacts WHERE id = ?", id);
}

const NAME_PREFIX_PLATFORMS = new Set(["facebook", "instagram"]);

function isEmail(value: string): boolean {
  return /@/.test(value) && !/\s/.test(value);
}

function normalizePhoneNumber(number: string): string {
  const cleaned = number.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    return "+44" + cleaned.slice(1);
  }
  return cleaned;
}

function isProbablyPhoneNumber(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  return digits.length >= 7;
}

export function normalizeIdentityInput(
  alias: string,
  source?: string
): { platform: Platform; platformId: string; displayName?: string } | null {
  if (
    source &&
    alias.startsWith("name:") &&
    isValidPlatform(source) &&
    (NAME_PREFIX_PLATFORMS.has(source) || source === "google-calendar" || source === "linkedin")
  ) {
    return { platform: source, platformId: alias, displayName: alias.slice("name:".length) };
  }

  const parsed = parseIdentifier(alias);
  if (parsed && isValidPlatform(parsed.platform)) {
    return { platform: parsed.platform, platformId: parsed.platformId };
  }

  if (source && PHONE_IDENTITY_SOURCES.has(source)) source = PHONE_IDENTITY_PLATFORM;

  if (!source || !isValidPlatform(source)) return null;

  if (source === PHONE_IDENTITY_PLATFORM) {
    if (!isProbablyPhoneNumber(alias)) return null;
    const normalized = normalizePhoneNumber(alias);
    if (!normalized) return null;
    return { platform: "phone", platformId: normalized, displayName: alias };
  }

  if (source === "google-chat") {
    if (!isEmail(alias)) return null;
    return { platform: "google-chat", platformId: alias, displayName: alias };
  }

  if (source === "google-calendar") {
    if (isEmail(alias)) {
      return { platform: "google-calendar", platformId: alias, displayName: alias };
    }
    return { platform: "google-calendar", platformId: `name:${alias}`, displayName: alias };
  }

  if (source === "linkedin") {
    if (alias.includes(" ")) {
      return { platform: "linkedin", platformId: `name:${alias}`, displayName: alias };
    }
    return { platform: "linkedin", platformId: alias, displayName: alias };
  }

  if (NAME_PREFIX_PLATFORMS.has(source) && !alias.startsWith("name:")) {
    return { platform: source, platformId: `name:${alias}`, displayName: alias };
  }

  return { platform: source, platformId: alias, displayName: alias };
}

/**
 * Get all aliases for a contact
 */
export async function getAliasesForContact(db: QueryExecutor, contactId: number): Promise<ContactAlias[]> {
  const rows = await db.query<{
    id: number;
    contact_id: number;
    platform: string;
    platform_id: string;
    display_name: string | null;
    username: string | null;
    first_seen: string;
  }>(`
    SELECT id, contact_id, platform, platform_id, display_name, username, first_seen
    FROM identities
    WHERE contact_id = ?
    ORDER BY platform, display_name, username, platform_id
  `, contactId);

  return rows.map((row) => ({
    id: row.id,
    contact_id: row.contact_id,
    alias: formatIdentifier(row.platform, row.platform_id),
    source: row.platform,
    created_at: row.first_seen,
  }));
}

/**
 * Resolve an alias to a contact
 * Returns the contact if the alias is linked, null otherwise
 */
export async function resolveAlias(
  db: QueryExecutor,
  alias: string,
  source?: string
): Promise<Contact | null> {
  if (!(source && alias.startsWith("name:"))) {
    const parsed = parseIdentifier(alias);
    if (parsed) {
      const row = await db.get<Contact>(`
        SELECT c.* FROM identities i
        JOIN contacts c ON i.contact_id = c.id
        WHERE i.platform = ? AND i.platform_id = ?
        LIMIT 1
      `, parsed.platform, parsed.platformId);
      return row;
    }
  }

  if (!source) return null;

  const normalized = normalizeIdentityInput(alias, source);
  if (!normalized) return null;

  const exact = await db.get<Contact>(`
    SELECT c.* FROM identities i
    JOIN contacts c ON i.contact_id = c.id
    WHERE i.platform = ? AND i.platform_id = ?
    LIMIT 1
  `, normalized.platform, normalized.platformId);
  if (exact) return exact;

  const fallback = await db.get<Contact>(`
    SELECT c.* FROM identities i
    JOIN contacts c ON i.contact_id = c.id
    WHERE i.platform = ?
      AND (i.display_name = ? OR i.username = ?)
    LIMIT 1
  `, source, alias, alias);
  return fallback;
}

function addContactEventFilters(
  conditions: string[],
  params: (string | number)[],
  { query, source, type, chat }: Pick<SearchOptions, "query" | "source" | "type" | "chat">,
): void {
  if (query) addTextSearch(conditions, params, query, "e");
  if (source) {
    const sources = source.split(',').map(s => s.trim()).filter(Boolean);
    conditions.push(sources.length > 0
      ? `e.source IN (${sources.map(() => '?').join(', ')})`
      : '0 = 1');
    params.push(...sources);
  }
  if (type) {
    const types = type.split(',').map(t => t.trim()).filter(Boolean);
    conditions.push(types.length > 0
      ? `(${types.map(() => 'substr(e.type, 1, ?) = ?').join(' OR ')})`
      : '0 = 1');
    for (const prefix of types) params.push(prefix.length, prefix);
  }
  if (chat) {
    conditions.push(`instr(lower(e.title), lower(?)) > 0 AND (substr(e.type, 1, 7) = 'message' OR e.source = 'phone')`);
    params.push(chat);
  }
}

/**
 * Search events by contact - returns all events involving any of the contact's aliases
 * Uses the event_people index table with timestamp for fast sorted lookups
 * Merges sender, DM recipient, and manual participant matches after filtering
 */
export async function searchByContact(
  db: QueryExecutor,
  contactId: number,
  options?: Omit<SearchOptions, "includeHiddenContacts">
): Promise<TimelineEvent[]> {
  const identities = await getIdentitiesForContact(db, contactId);

  // Build list of all identifiers for this contact: platform identities + "contact:N"
  const allIdentifiers: string[] = identities.map(i => formatIdentifier(i.platform, i.platform_id));
  allIdentifiers.push(`contact:${contactId}`);

  const { query, source, type, startDate, endDate, chat, limit = 50, cursor, sort } = options ?? {};
  // Use explicit sort if provided, otherwise: ASC for date range (chronological), DESC otherwise (recent first)
  const sortOrder = sort === 'asc' ? "ASC" : sort === 'desc' ? "DESC" : (startDate || endDate) ? "ASC" : "DESC";

  // Build additional filter conditions
  const filterConditions: string[] = [];
  const filterParams: (string | number)[] = [];

  if (startDate) {
    filterConditions.push(`timestamp >= ?`);
    filterParams.push(startDate);
  }

  if (endDate) {
    const endDateValue = endDate.length === 10 ? endDate + "T23:59:59.999Z" : endDate;
    filterConditions.push(`timestamp <= ?`);
    filterParams.push(endDateValue);
  }

  if (cursor) {
    const parsed = parseCursor(cursor);
    if (parsed) {
      if (sortOrder === "DESC") {
        filterConditions.push(`(timestamp < ? OR (timestamp = ? AND event_id < ?))`);
      } else {
        filterConditions.push(`(timestamp > ? OR (timestamp = ? AND event_id > ?))`);
      }
      filterParams.push(parsed.timestamp, parsed.timestamp, parsed.id);
    }
  }

  // Build filter clause with table prefix for JOINed queries
  const filterConditionsWithPrefix = filterConditions.map(c =>
    c.replace(/\btimestamp\b/g, "ep.timestamp").replace(/\bevent_id\b/g, "ep.event_id")
  );
  const queryParams: (string | number)[] = [];
  addContactEventFilters(filterConditionsWithPrefix, queryParams, { query, source, type, chat });
  const filterClauseWithPrefix = filterConditionsWithPrefix.length > 0
    ? ` AND ${filterConditionsWithPrefix.join(" AND ")}`
    : "";
  const combinedFilterParams = [...filterParams, ...queryParams];

  // Use IN (...) instead of per-identifier UNION ALL to avoid SQLite compound SELECT limit
  const placeholders = allIdentifiers.map(() => "?").join(", ");

  // Three branches:
  // 1. Events where contact is sender (people[0]) - covers all event types
  // 2. DM events where contact is recipient - direct participant even if not sender
  // 3. Manual events where contact is any participant (notes associate people, no sender concept)
  const unionQuery = `
    SELECT DISTINCT event_id FROM (
      SELECT * FROM (
        SELECT ep.event_id, ep.timestamp FROM event_people ep
        JOIN events e ON e.id = ep.event_id
        WHERE ep.person IN (${placeholders}) AND ep.is_sender = 1${filterClauseWithPrefix}
        ORDER BY ep.timestamp ${sortOrder}, ep.event_id ${sortOrder}
        LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT ep.event_id, ep.timestamp FROM event_people ep
        JOIN events e ON e.id = ep.event_id
        WHERE ep.person IN (${placeholders}) AND ep.is_sender = 0 AND (e.type LIKE 'message:dm%' OR e.source = 'phone')${filterClauseWithPrefix}
        ORDER BY ep.timestamp ${sortOrder}, ep.event_id ${sortOrder}
        LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT ep.event_id, ep.timestamp FROM event_people ep
        JOIN events e ON e.id = ep.event_id
        WHERE ep.person IN (${placeholders}) AND ep.is_sender = 0 AND e.source = 'manual'${filterClauseWithPrefix}
        ORDER BY ep.timestamp ${sortOrder}, ep.event_id ${sortOrder}
        LIMIT ?
      )
    )
    ORDER BY timestamp ${sortOrder}, event_id ${sortOrder}
    LIMIT ?
  `;
  const allParams: (string | number)[] = [
    ...allIdentifiers, ...combinedFilterParams, limit,
    ...allIdentifiers, ...combinedFilterParams, limit,
    ...allIdentifiers, ...combinedFilterParams, limit,
    limit,
  ];

  const eventRows = await db.query<{ event_id: number }>(unionQuery, ...allParams);
  if (eventRows.length === 0) return [];

  // Fetch full events by IDs
  const eventIds = eventRows.map(r => r.event_id);
  const events = await db.query<TimelineEvent>(`
    SELECT * FROM events
    WHERE id IN (${eventIds.map(() => '?').join(',')})
    ORDER BY timestamp ${sortOrder}, id ${sortOrder}
  `, ...eventIds);

  return transformEvents(events);
}

export interface ContactConversation {
  source: string;
  sourceAccount: string | null;
  conversationId: string;
  title: string;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

/**
 * Get conversations a contact participates in, grouped by stable conversation id.
 * Uses event_people index for efficient lookups.
 */
export async function getContactConversations(
  db: QueryExecutor,
  contactId: number
): Promise<ContactConversation[]> {
  const identities = await getIdentitiesForContact(db, contactId);

  const allIdentifiers: string[] = identities.map(i => formatIdentifier(i.platform, i.platform_id));
  allIdentifiers.push(`contact:${contactId}`);

  const placeholders = allIdentifiers.map(() => "?").join(", ");

  const sql = `
    WITH grouped AS (
      SELECT
        e.source,
        e.source_account,
        e.conversation_id,
        COUNT(*) as messageCount,
        MIN(e.timestamp) as firstMessage,
        MAX(e.timestamp) as lastMessage
      FROM event_people ep
      JOIN events e ON e.id = ep.event_id
      WHERE ep.person IN (${placeholders})
        AND ${conversationTypeClause("e.")}
        AND e.conversation_id IS NOT NULL
      GROUP BY e.source, e.source_account, e.conversation_id
      ORDER BY lastMessage DESC
      LIMIT 200
    )
    SELECT
      g.source,
      g.source_account as sourceAccount,
      g.conversation_id as conversationId,
      (
        SELECT e.title
        FROM events e
        WHERE e.source = g.source
          AND e.source_account IS g.source_account
          AND e.conversation_id = g.conversation_id
          AND ${conversationTypeClause("e.")}
          AND e.title IS NOT NULL
        ORDER BY e.timestamp DESC, e.id DESC
        LIMIT 1
      ) as title,
      g.messageCount,
      g.firstMessage,
      g.lastMessage
    FROM grouped g
    WHERE title IS NOT NULL
    ORDER BY g.lastMessage DESC
  `;

  return await db.query<ContactConversation>(sql, ...allIdentifiers);
}

/**
 * Search events by alias - returns all events involving a specific person
 * Uses event_people index for fast sorted lookups
 */
export async function searchByAlias(
  db: QueryExecutor,
  alias: string,
  aliasSource?: string,
  options?: { limit?: number; cursor?: string }
): Promise<{ events: TimelineEvent[]; nextCursor: string | null; count: number }> {
  const { limit = 50, cursor } = options ?? {};

  // Get total count using the index
  const countResult = aliasSource
    ? await db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM event_people WHERE person = ? AND source = ?`,
        alias, aliasSource
      )
    : await db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM event_people WHERE person = ?`,
        alias
      );
  const count = countResult?.count ?? 0;

  // Build conditions for the event_people lookup
  const conditions: string[] = ["person = ?"];
  const params: (string | number)[] = [alias];
  if (aliasSource) {
    conditions.push("source = ?");
    params.push(aliasSource);
  }

  if (cursor) {
    const parsed = parseCursor(cursor);
    if (parsed) {
      conditions.push(`(timestamp < ? OR (timestamp = ? AND event_id < ?))`);
      params.push(parsed.timestamp, parsed.timestamp, parsed.id);
    }
  }

  // Get event_ids using the index with timestamp ordering
  const epSql = `
    SELECT event_id FROM event_people
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp DESC, event_id DESC
    LIMIT ?
  `;
  params.push(limit + 1); // Fetch one extra to check if there's more

  const eventRows = await db.query<{ event_id: number }>(epSql, ...params);
  const hasMore = eventRows.length > limit;
  const eventIds = (hasMore ? eventRows.slice(0, limit) : eventRows).map(r => r.event_id);

  if (eventIds.length === 0) {
    return { events: [], nextCursor: null, count };
  }

  // Fetch full events by IDs
  const eventsSql = `
    SELECT * FROM events
    WHERE id IN (${eventIds.map(() => '?').join(',')})
    ORDER BY timestamp DESC, id DESC
  `;
  const events = transformEvents(await db.query<TimelineEvent>(eventsSql, ...eventIds));
  const nextCursor = hasMore && events.length > 0
    ? createCursor(events[events.length - 1])
    : null;

  return { events, nextCursor, count };
}

/**
 * Get contacts with their event counts
 */
export interface ContactWithStats extends Contact {
  identityCount: number;
  platformCount: number;
  activeIdentityCount: number;
  eventCount: number;
  avatarUrl: string | null;
}

/**
 * Count total contacts (fast query for dashboard)
 */
export async function countContacts(db: QueryExecutor, options?: { includeHidden?: boolean }): Promise<number> {
  const whereClause = options?.includeHidden ? "" : "WHERE hidden = 0";
  const sql = `SELECT COUNT(*) as count FROM contacts ${whereClause}`;
  const result = await db.get<{ count: number }>(sql);
  return result?.count ?? 0;
}

// ============================================================================
// Manual contact alias event counts
// ============================================================================

interface AliasEventCounts {
  // Map of "alias:source" -> event count
  counts: Record<string, number>;
}

// Sources where "people" represent channels/artists, not actual people
const NON_PERSON_SOURCES = ["youtube"];

/**
 * Event counts for manual "contact:N" aliases only.
 *
 * listContacts needs alias counts solely for direct contact references (manual
 * events keyed "contact:N:<source>"); platform identities already carry a
 * denormalized identities.event_count. A range scan over the (person, source)
 * index returns this small subset efficiently; a full GROUP BY over
 * event_people can exceed the query-pool timeout on large databases.
 *
 * Uses range bounds (person >= 'contact:' AND person < 'contact;') rather than
 * LIKE 'contact:%': SQLite's default case-insensitive LIKE can't use the
 * (person, source) index for a prefix match, but the binary range bounds can.
 * ';' (0x3B) is the byte after ':' (0x3A), so the
 * half-open range covers exactly the "contact:" prefix.
 */
export async function getContactAliasEventCounts(db: QueryExecutor): Promise<AliasEventCounts> {
  const excludeList = NON_PERSON_SOURCES.map(() => "?").join(",");
  const sql = `
    SELECT person as alias, source, COUNT(*) as count
    FROM event_people
    WHERE person >= 'contact:' AND person < 'contact;'
      AND source NOT IN (${excludeList})
    GROUP BY person, source
  `;
  const rows = await db.query<{ alias: string; source: string; count: number }>(sql, ...NON_PERSON_SOURCES);

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[`${row.alias}:${row.source}`] = row.count;
  }
  return { counts };
}

const AVATAR_PLATFORM_PRIORITY = ["discord", "github", "spotify", "facebook", "instagram"];

/**
 * Pick the best avatar URL from a list of identities.
 * Prefers platforms in priority order (discord > github > spotify > ...).
 */
export function pickBestAvatar(identities: Array<{ platform: string; avatar_url: string | null }>): string | null {
  const withAvatar = identities.filter(i => i.avatar_url);
  if (withAvatar.length === 0) return null;
  withAvatar.sort((a, b) => {
    const aIdx = AVATAR_PLATFORM_PRIORITY.indexOf(a.platform);
    const bIdx = AVATAR_PLATFORM_PRIORITY.indexOf(b.platform);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });
  return withAvatar[0].avatar_url;
}

/**
 * List contacts with stats including event counts.
 * Platform identity counts come from the denormalized identities.event_count;
 * manual "contact:N" references use a scoped index lookup (getContactAliasEventCounts).
 */
export async function listContacts(
  db: QueryExecutor,
  options?: { includeHidden?: boolean; search?: string; ids?: number[] }
): Promise<ContactWithStats[]> {
  if (options?.ids && options.ids.length === 0) return [];

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (!options?.includeHidden) {
    conditions.push("c.hidden = 0");
  }

  if (options?.search) {
    conditions.push("c.display_name LIKE ?");
    params.push(`%${options.search}%`);
  }

  if (options?.ids && options.ids.length > 0) {
    conditions.push(`c.id IN (${options.ids.map(() => "?").join(", ")})`);
    params.push(...options.ids);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get contacts with identity counts
  const contactsSql = `
    SELECT
      c.*,
      (SELECT COUNT(*) FROM identities i WHERE i.contact_id = c.id) as identityCount,
      (SELECT COUNT(DISTINCT i.platform) FROM identities i WHERE i.contact_id = c.id) as platformCount,
      (SELECT COUNT(*) FROM identities i WHERE i.contact_id = c.id AND i.event_count > 0) as activeIdentityCount,
      0 as eventCount
    FROM contacts c
    ${whereClause}
    ORDER BY c.is_self DESC, c.display_name COLLATE NOCASE
  `;
  const contacts = await db.query<ContactWithStats>(contactsSql, ...params);

  if (contacts.length === 0) return contacts;

  // Get all identities for these contacts
  const contactIds = contacts.map(c => c.id);
  const identitiesSql = `
    SELECT contact_id, platform, platform_id, avatar_url, event_count
    FROM identities
    WHERE contact_id IN (${contactIds.map(() => '?').join(',')})
  `;
  const identities = await db.query<{
    contact_id: number;
    platform: string;
    platform_id: string;
    avatar_url: string | null;
    event_count: number;
  }>(identitiesSql, ...contactIds);

  // Event counts for direct contact references (manual "contact:N" events).
  // Platform identities already contribute via identities.event_count (Pass 1);
  // only the small manual-contact alias subset needs a lookup here.
  const { counts: countMap } = await getContactAliasEventCounts(db);

  // Sum event counts for each contact and collect avatars
  const contactEventCounts = new Map<number, number>();
  const contactAvatars = new Map<number, Array<{ platform: string; avatar_url: string | null }>>();

  // Pass 1: Count events from platform identities
  for (const identity of identities) {
    const contactId = identity.contact_id;
    contactEventCounts.set(contactId, (contactEventCounts.get(contactId) || 0) + identity.event_count);

    let avatars = contactAvatars.get(contactId);
    if (!avatars) {
      avatars = [];
      contactAvatars.set(contactId, avatars);
    }
    avatars.push({ platform: identity.platform, avatar_url: identity.avatar_url });
  }

  // Pass 2: Count events from direct contact references (manual events with "contact:N")
  for (const contact of contacts) {
    const contactPrefix = `contact:${contact.id}:`;
    let count = 0;
    for (const [key, c] of Object.entries(countMap)) {
      if (key.startsWith(contactPrefix)) {
        count += c;
      }
    }
    if (count > 0) {
      contactEventCounts.set(contact.id, (contactEventCounts.get(contact.id) || 0) + count);
    }
  }

  // Apply counts and avatars to contacts
  for (const contact of contacts) {
    contact.eventCount = contactEventCounts.get(contact.id) || 0;
    (contact as ContactWithStats).avatarUrl = pickBestAvatar(contactAvatars.get(contact.id) || []);
  }

  return contacts;
}

// ============================================================================
// Spotify summary for contacts
// ============================================================================

export interface ContactSpotifySummary {
  totalListens: number;
  firstListen: string | null;
  lastListen: string | null;
  topArtists: Array<{ name: string; listenCount: number }>;
  topTracks: Array<{ name: string; artist: string; listenCount: number }>;
}

/**
 * Get Spotify listening summary for a contact.
 * Aggregates both own Spotify events and Spotify Friends events.
 * Returns null if the contact has no Spotify identities.
 */
export async function getContactSpotifySummary(
  db: QueryExecutor,
  contactId: number
): Promise<ContactSpotifySummary | null> {
  const identities = await getIdentitiesForContact(db, contactId);
  const spotifyIdentities = identities.filter(i => i.platform === "spotify");
  if (spotifyIdentities.length === 0) return null;

  const persons = spotifyIdentities.map(i => formatIdentifier(i.platform, i.platform_id));

  const personPlaceholders = persons.map(() => "?").join(",");
  const sourceFilter = `ep.person IN (${personPlaceholders}) AND e.source IN ('spotify', 'spotify-friends') AND e.type LIKE 'listen:track%'`;

  // Stats: total listens, date range
  const stats = await db.get<{ totalListens: number; firstListen: string | null; lastListen: string | null }>(`
    SELECT COUNT(*) as totalListens, MIN(e.timestamp) as firstListen, MAX(e.timestamp) as lastListen
    FROM event_people ep
    JOIN events e ON e.id = ep.event_id
    WHERE ${sourceFilter}
  `, ...persons);

  if (!stats || stats.totalListens === 0) {
    return { totalListens: 0, firstListen: null, lastListen: null, topArtists: [], topTracks: [] };
  }

  // Top artists from tags
  const topArtists = await db.query<{ name: string; listenCount: number }>(`
    SELECT SUBSTR(t.value, 8) as name, COUNT(*) as listenCount
    FROM event_people ep
    JOIN events e ON e.id = ep.event_id, json_each(e.tags) t
    WHERE ${sourceFilter} AND t.value LIKE 'artist:%'
    GROUP BY name
    ORDER BY listenCount DESC
    LIMIT 10
  `, ...persons);

  // Top tracks (group by title + artist to avoid merging different songs with same name)
  const topTracks = await db.query<{ name: string; artist: string; listenCount: number }>(`
    SELECT name, artist, SUM(listenCount) as listenCount FROM (
      SELECT e.title as name,
        (SELECT SUBSTR(t2.value, 8) FROM json_each(e.tags) t2 WHERE t2.value LIKE 'artist:%' LIMIT 1) as artist,
        COUNT(*) as listenCount
      FROM event_people ep
      JOIN events e ON e.id = ep.event_id
      WHERE ${sourceFilter} AND e.title IS NOT NULL
      GROUP BY e.title, artist
    )
    GROUP BY name, artist
    ORDER BY listenCount DESC
    LIMIT 10
  `, ...persons);

  return {
    totalListens: stats.totalListens,
    firstListen: stats.firstListen,
    lastListen: stats.lastListen,
    topArtists,
    topTracks,
  };
}
