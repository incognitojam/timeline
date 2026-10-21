import {
  latestAttachmentDescriptionSelect,
  loadAttachmentDescriptionsForEvents,
} from "../export/attachment-descriptions";
import { collectRenderedIdentifiers } from "../export/display-names";
import { renderConversationTranscript } from "../export/render";
import { loadReplyQuotesForEvents } from "../export/reply-quotes";
import { countTokens } from "../export/tokens";
import { AI_USAGE_SOURCES, estimateCostUsd, tokenUsageFromExtract, USAGE_EXTRACT_SQL } from "../lib/ai-usage";
import { type ConversationRangeExportFormat, normalizeConversationRangeExportFormat } from "../shared/conversation-export";
import { conversationTypeClause } from "./conversation-types";
import { createCursor, parseCursor, transformEvent, transformEvents } from "./events";
import { parseIdentifier, resolveIdentities } from "./identities";
import type { QueryExecutor } from "./pool";
import { conversationSourceAccountKey, type TimelineEvent } from "./schema";

export { conversationTypeClause } from "./conversation-types";

interface ConversationKey {
  conversationId: string;
  title: string;
  sourceAccount: string | null | undefined;
  summary: ConversationSummarySnapshot | null;
}

interface ConversationSummarySnapshot {
  sourceAccount: string | null;
  sourceAccountKey: string;
  conversationId: string;
  title: string;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

// Captured earlier versions of a message (edits observed by sync) live in
// event_versions; the count lets conversation surfaces mark edited messages.
function versionCountSelect(alias: string): string {
  return `(SELECT COUNT(*) FROM event_versions v WHERE v.event_id = ${alias}id) AS version_count`;
}

function addSourceAccountCondition(
  conditions: string[],
  params: (string | number)[],
  sourceAccount: string | null | undefined,
  alias = "",
): void {
  if (sourceAccount === undefined) return;
  if (sourceAccount === null) {
    conditions.push(`${alias}source_account IS NULL`);
    return;
  }
  conditions.push(`${alias}source_account = ?`);
  params.push(sourceAccount);
}

async function getConversationSummaryByKey(
  db: QueryExecutor,
  source: string,
  sourceAccount: string | null,
  conversationId: string,
): Promise<ConversationSummarySnapshot | null> {
  return db.get<ConversationSummarySnapshot>(`
    SELECT
      cs.source_account AS sourceAccount,
      cs.source_account_key AS sourceAccountKey,
      cs.conversation_id AS conversationId,
      cs.title,
      cs.message_count AS messageCount,
      cs.first_message AS firstMessage,
      cs.last_message AS lastMessage
    FROM conversation_summaries cs
    WHERE cs.source = ?
      AND cs.source_account_key = ?
      AND cs.conversation_id = ?
  `, source, conversationSourceAccountKey(sourceAccount), conversationId);
}

async function getConversationSummaryById(
  db: QueryExecutor,
  source: string,
  conversationId: string,
): Promise<ConversationSummarySnapshot | null> {
  return db.get<ConversationSummarySnapshot>(`
    SELECT
      cs.source_account AS sourceAccount,
      cs.source_account_key AS sourceAccountKey,
      cs.conversation_id AS conversationId,
      cs.title,
      cs.message_count AS messageCount,
      cs.first_message AS firstMessage,
      cs.last_message AS lastMessage
    FROM conversation_summaries cs
    WHERE cs.source = ?
      AND cs.conversation_id = ?
    ORDER BY cs.last_message DESC
    LIMIT 1
  `, source, conversationId);
}

async function getConversationKey(
  db: QueryExecutor,
  source: string,
  conversationId: string,
  sourceAccount: string | undefined,
): Promise<ConversationKey> {
  const summary = sourceAccount === undefined
    ? await getConversationSummaryById(db, source, conversationId)
    : await getConversationSummaryByKey(db, source, sourceAccount, conversationId);
  return {
    conversationId,
    title: summary?.title ?? conversationId,
    sourceAccount: summary?.sourceAccount ?? sourceAccount,
    summary,
  };
}

function buildConversationFilter(
  key: Pick<ConversationKey, "conversationId">,
  alias = "",
): { clause: string; param: string } {
  return { clause: `${alias}conversation_id = ?`, param: key.conversationId };
}

function sameCanonicalConversation(a: TimelineEvent, b: TimelineEvent): boolean {
  if (a.source !== b.source) return false;
  if ((a.source_account ?? null) !== (b.source_account ?? null)) return false;
  return !!a.conversation_id && a.conversation_id === b.conversation_id;
}

function compareConversationPosition(a: TimelineEvent, b: TimelineEvent): number {
  const aTimestamp = a.timestamp ?? "";
  const bTimestamp = b.timestamp ?? "";
  if (aTimestamp < bTimestamp) return -1;
  if (aTimestamp > bTimestamp) return 1;
  return a.id - b.id;
}

function fallbackNameFromIdentifier(identifier: string): string {
  const parsed = parseIdentifier(identifier);
  if (parsed?.platformId.startsWith("name:")) {
    return parsed.platformId.slice("name:".length);
  }
  return parsed?.platformId || identifier;
}

function collectPeopleIdentifiers(events: TimelineEvent[]): string[] {
  const identifiers = new Set<string>();
  for (const event of events) {
    if (!event.people) continue;
    try {
      const people = JSON.parse(event.people) as unknown;
      if (!Array.isArray(people)) continue;
      for (const person of people) {
        if (typeof person === "string" && person) identifiers.add(person);
      }
    } catch {
      // Ignore malformed people JSON and fall back to renderer defaults.
    }
  }
  return Array.from(identifiers);
}

function createParticipantAnonymiser(
  identifiers: string[],
  displayNames: Record<string, string>,
): { displayNames: Record<string, string>; anonymiseName: (name: string, identifier?: string) => string } {
  const anonymousDisplayNames = Object.fromEntries(
    identifiers.map((identifier, index) => [identifier, `Person ${index + 1}`]),
  );
  const aliasesByName = new Map(
    identifiers.map((identifier) => [displayNames[identifier], anonymousDisplayNames[identifier]]),
  );
  let nextAlias = identifiers.length + 1;
  return {
    displayNames: anonymousDisplayNames,
    // Identifier first: one person arrives under several names, and one name can
    // belong to several people.
    anonymiseName: (name, identifier) => {
      const existing = (identifier ? anonymousDisplayNames[identifier] : undefined)
        ?? aliasesByName.get(name);
      if (existing) {
        if (identifier) anonymousDisplayNames[identifier] = existing;
        return existing;
      }
      const alias = `Person ${nextAlias++}`;
      if (identifier) anonymousDisplayNames[identifier] = alias;
      aliasesByName.set(name, alias);
      return alias;
    },
  };
}

/**
 * Whether a conversation is titled after a place rather than its participants.
 * Only Discord guild channels are, and only they carry `_channel.guild_id`.
 */
function isNamedChannel(event: TimelineEvent): boolean {
  if (event.source !== "discord" || !event.raw_data) return false;
  try {
    const raw = JSON.parse(event.raw_data) as { _channel?: { guild_id?: unknown } };
    return typeof raw._channel?.guild_id === "string";
  } catch {
    return false;
  }
}

/**
 * The transcript heading for an anonymised export. Rebuilt rather than redacted:
 * the stored title is itself a captured name, so matching text against resolved
 * contacts would miss most of them.
 */
function anonymisedTranscriptTitle(
  events: TimelineEvent[],
  storedTitle: string | null,
  peopleIdentifiers: string[],
  anonymousDisplayNames: Record<string, string>,
): string | null {
  if (events.some(isNamedChannel)) return storedTitle;
  const aliases = peopleIdentifiers
    .map((identifier) => anonymousDisplayNames[identifier])
    .filter((alias): alias is string => Boolean(alias));
  return aliases.length > 0 ? aliases.join(", ") : null;
}

export interface ConversationRangeExportResult {
  text: string;
  eventCount: number;
  tokenCount: number;
  range: {
    startEventId: number;
    endEventId: number;
    requestedStartEventId: number;
    requestedEndEventId: number;
    source: string;
    sourceAccount: string | null;
    conversationId: string | null;
    title: string | null;
    startTimestamp: string | null;
    endTimestamp: string | null;
  };
}

export async function exportConversationRange(
  db: QueryExecutor,
  options: {
    startEventId: number;
    endEventId: number;
    format?: Partial<ConversationRangeExportFormat>;
    preferredDescriptionModels?: readonly string[];
  },
): Promise<ConversationRangeExportResult> {
  const endpoints = transformEvents(await db.query<TimelineEvent>(
    "SELECT * FROM events WHERE id IN (?, ?)",
    options.startEventId,
    options.endEventId,
  ));
  const startEndpoint = endpoints.find((event) => event.id === options.startEventId);
  const endEndpoint = endpoints.find((event) => event.id === options.endEventId);

  if (!startEndpoint) {
    throw new Error(`Event ${options.startEventId} was not found`);
  }
  if (!endEndpoint) {
    throw new Error(`Event ${options.endEventId} was not found`);
  }
  if (!sameCanonicalConversation(startEndpoint, endEndpoint)) {
    throw new Error("Events do not belong to the same conversation");
  }
  if (!startEndpoint.timestamp || !endEndpoint.timestamp) {
    throw new Error("Conversation range endpoints must have timestamps");
  }

  const [first, last] = compareConversationPosition(startEndpoint, endEndpoint) <= 0
    ? [startEndpoint, endEndpoint]
    : [endEndpoint, startEndpoint];
  if (!first.conversation_id) {
    throw new Error("Conversation range endpoints must have conversation ids");
  }
  const filter = buildConversationFilter({ conversationId: first.conversation_id }, "e.");
  const conditions = [
    filter.clause,
    "e.source = ?",
    "e.source_account IS ?",
    conversationTypeClause("e."),
    "(e.timestamp > ? OR (e.timestamp = ? AND e.id >= ?))",
    "(e.timestamp < ? OR (e.timestamp = ? AND e.id <= ?))",
  ];
  const events = transformEvents(await db.query<TimelineEvent>(`
    SELECT * FROM events e
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.timestamp ASC, e.id ASC
  `,
    filter.param,
    first.source,
    first.source_account,
    first.timestamp,
    first.timestamp,
    first.id,
    last.timestamp,
    last.timestamp,
    last.id,
  ));

  const peopleIdentifiers = collectPeopleIdentifiers(events);
  const identifiers = [...new Set([
    ...peopleIdentifiers,
    ...events.flatMap((event) => collectRenderedIdentifiers(event)),
  ])];
  const resolved = await resolveIdentities(db, identifiers);
  // Kept apart from displayNames, whose fallback is the bare identifier: a body
  // surface falls back to the name captured with it instead.
  const resolvedNames: Record<string, string> = {};
  for (const identifier of identifiers) {
    const identity = resolved[identifier];
    const name = identity?.name || identity?.username;
    if (name) resolvedNames[identifier] = name;
  }
  const displayNames = Object.fromEntries(identifiers.map((identifier) =>
    [identifier, resolvedNames[identifier] ?? fallbackNameFromIdentifier(identifier)]));

  const format = normalizeConversationRangeExportFormat(options.format);
  const anonymiser = format.anonymiseNames
    ? createParticipantAnonymiser(identifiers, displayNames)
    : null;
  const anonymisedDiscordUserResolver = anonymiser
    ? (id: string): string => {
      const identifier = `discord:${id}`;
      return anonymiser.anonymiseName(displayNames[identifier] ?? identifier, identifier);
    }
    : undefined;
  const rangeTitle = last.title ?? first.title;
  // The returned range keeps the real title; only the transcript text travels.
  const transcriptTitle = anonymiser
    ? anonymisedTranscriptTitle(events, rangeTitle, peopleIdentifiers, anonymiser.displayNames)
    : rangeTitle;
  const attachmentDescriptions = await loadAttachmentDescriptionsForEvents(
    db,
    events,
    options.preferredDescriptionModels,
  );
  const replyQuotes = await loadReplyQuotesForEvents(db, events, {
    discordUserResolver: anonymisedDiscordUserResolver ?? ((id) => resolvedNames[`discord:${id}`] ?? null),
    participantNameResolver: anonymiser?.anonymiseName,
    timeZone: format.timeZone,
  });
  const text = renderConversationTranscript(events, {
    source: first.source,
    title: transcriptTitle,
    timestampStyle: format.timestampStyle,
    displayNames: anonymiser?.displayNames ?? displayNames,
    discordUserResolver: anonymisedDiscordUserResolver ?? ((id) => resolvedNames[`discord:${id}`] ?? null),
    reactionActorNameResolver: (actor) => {
      const name = (actor.identifier ? resolvedNames[actor.identifier] : undefined) ?? actor.name;
      return anonymiser ? anonymiser.anonymiseName(name, actor.identifier ?? undefined) : name;
    },
    includeReactions: format.includeReactions,
    compactAuthors: format.compactAuthors,
    timeZone: format.timeZone,
    attachmentDescriptions,
    replyQuotes,
  });

  return {
    text,
    eventCount: events.length,
    tokenCount: countTokens(text),
    range: {
      startEventId: first.id,
      endEventId: last.id,
      requestedStartEventId: options.startEventId,
      requestedEndEventId: options.endEventId,
      source: first.source,
      sourceAccount: first.source_account ?? null,
      conversationId: first.conversation_id ?? null,
      title: rangeTitle,
      startTimestamp: first.timestamp,
      endTimestamp: last.timestamp,
    },
  };
}

export interface ConversationListItem {
  source: string;
  sourceAccount: string | null;
  conversationId: string;
  title: string;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

export interface QueryTiming {
  start: (name: string, description: string) => void;
  end: (name: string) => void;
}

async function withQueryTiming<T>(
  timing: QueryTiming | undefined,
  name: string,
  description: string,
  operation: () => Promise<T>,
): Promise<T> {
  timing?.start(name, description);
  try {
    return await operation();
  } finally {
    timing?.end(name);
  }
}

export async function listConversationSources(db: QueryExecutor): Promise<string[]> {
  const rows = await db.query<{ source: string }>(`
    SELECT DISTINCT source
    FROM conversation_summaries
    ORDER BY source
  `);
  return rows.map((row) => row.source);
}

export interface ListConversationsOptions {
  search?: string;
  source?: string;
  limit?: number;
  offset?: number;
  timing?: QueryTiming;
}

/**
 * List all conversations grouped by stable `conversation_id`. The displayed
 * `title` is the most recent one for the group, so renamed Discord channels
 * collapse to a single row showing the current name.
 */
export async function listConversations(
  db: QueryExecutor,
  options: ListConversationsOptions = {}
): Promise<{ conversations: ConversationListItem[]; total: number }> {
  const { search, source, limit = 50, offset = 0, timing } = options;

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (search) {
    conditions.push(`EXISTS (
      SELECT 1 FROM conversation_summary_titles cst
      WHERE cst.source = cs.source
        AND cst.source_account_key = cs.source_account_key
        AND cst.conversation_id = cs.conversation_id
        AND cst.title LIKE ?
    )`);
    params.push(`%${search}%`);
  }
  if (source) {
    conditions.push("cs.source = ?");
    params.push(source);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  timing?.start("conversations.count", "Grouped Conversation Count");
  const countPromise = db
    .get<{ total: number }>(
      `SELECT COUNT(*) as total FROM conversation_summaries cs ${where}`,
      ...params,
    )
    .finally(() => timing?.end("conversations.count"));

  timing?.start("conversations.page", "Conversation Summary Page");
  const pagePromise = db
    .query<ConversationListItem>(
      `SELECT
        cs.source,
        cs.source_account AS sourceAccount,
        cs.conversation_id AS conversationId,
        cs.title,
        cs.message_count AS messageCount,
        cs.first_message AS firstMessage,
        cs.last_message AS lastMessage
      FROM conversation_summaries cs
      ${where}
      ORDER BY cs.last_message DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    )
    .finally(() => timing?.end("conversations.page"));

  const [countResult, conversations] = await Promise.all([countPromise, pagePromise]);
  return { conversations, total: countResult?.total ?? 0 };
}

export interface ConversationOptions {
  conversationId: string;
  source: string;
  sourceAccount?: string;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";  // asc = oldest first (for conversation view), desc = newest first
}

export interface ConversationServerBreadcrumb {
  source: "discord";
  id: string;
  name: string | null;
}

export interface ConversationMetadata {
  title: string;
  server: ConversationServerBreadcrumb | null;
}

export async function getConversationMetadata(
  db: QueryExecutor,
  options: Pick<ConversationOptions, "conversationId" | "source" | "sourceAccount">,
): Promise<ConversationMetadata> {
  const key = await getConversationKey(db, options.source, options.conversationId, options.sourceAccount);
  if (options.source !== "discord") {
    return { title: key.title, server: null };
  }

  const filter = buildConversationFilter(key, "e.");
  const conditions = [
    filter.clause,
    "e.source = ?",
    conversationTypeClause("e."),
    "json_extract(e.raw_data, '$._channel.guild_id') IS NOT NULL",
  ];
  const params: (string | number)[] = [filter.param, options.source];
  // The resolved account (not just the optional request param) so the query
  // can seek idx_events_conversation_id, whose prefix is (source,
  // source_account, conversation_id) — without it SQLite walks every discord
  // row json_extract-ing raw_data (~5.5s and pool-timeout 500s under sync
  // contention on the host, vs 1ms with the seek).
  addSourceAccountCondition(conditions, params, key.sourceAccount, "e.");

  const row = await db.get<{ guildId: string | null; guildName: string | null }>(`
    SELECT
      json_extract(e.raw_data, '$._channel.guild_id') AS guildId,
      json_extract(e.raw_data, '$._channel.guild_name') AS guildName
    FROM events e
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.timestamp DESC, e.id DESC
    LIMIT 1
  `, ...params);

  return {
    title: key.title,
    server: row?.guildId
      ? { source: "discord", id: row.guildId, name: row.guildName ?? null }
      : null,
  };
}

/**
 * Get messages from a conversation by stable `conversation_id`.
 */
export async function getConversation(db: QueryExecutor, options: ConversationOptions): Promise<TimelineEvent[]> {
  const { conversationId, source, sourceAccount, limit = 100, cursor, order = "asc" } = options;

  const key = await getConversationKey(db, source, conversationId, sourceAccount);
  const filter = buildConversationFilter(key, "e.");

  const conditions: string[] = [
    filter.clause,
    "e.source = ?",
    conversationTypeClause("e."),
  ];
  const params: (string | number)[] = [filter.param, source];
  addSourceAccountCondition(conditions, params, key.sourceAccount, "e.");

  // Cursor-based pagination
  if (cursor) {
    const parsed = parseCursor(cursor);
    if (parsed) {
      if (order === "desc") {
        conditions.push(`(e.timestamp < ? OR (e.timestamp = ? AND e.id < ?))`);
      } else {
        conditions.push(`(e.timestamp > ? OR (e.timestamp = ? AND e.id > ?))`);
      }
      params.push(parsed.timestamp, parsed.timestamp, parsed.id);
    }
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const sortDir = order === "desc" ? "DESC" : "ASC";

  const sql = `
    SELECT e.*, ${versionCountSelect("e.")} FROM events e
    ${whereClause}
    ORDER BY e.timestamp ${sortDir}, e.id ${sortDir}
    LIMIT ?
  `;
  params.push(limit);

  return transformEvents(await db.query<TimelineEvent>(sql, ...params));
}

export interface ConversationTitleHistory {
  title: string;
  firstSeen: string;   // ISO timestamp of earliest message under this title
  lastSeen: string;    // ISO timestamp of latest message under this title
  messageCount: number;
}

export interface ConversationModelUsage {
  model: string;               // "unknown" when the event carried tokens but no model id
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;      // null = no published API pricing for this model
}

export interface ConversationTokenUsage {
  assistantMessages: number;   // assistant events carrying token accounting
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // Pay-as-you-go API-rate estimate over priced models only; null when no
  // tokens could be priced. Not actual spend on subscription plans.
  estimatedCostUsd: number | null;
  byModel: ConversationModelUsage[];
}

export interface ConversationStats {
  totalMessages: number;
  firstMessage: string | null;  // ISO timestamp
  lastMessage: string | null;
  firstEventId: number | null;  // id of the earliest timestamped message (anchors a whole-conversation export)
  lastEventId: number | null;   // id of the latest timestamped message
  participants: { identifier: string; name: string; contactId: number | null; avatarUrl: string | null; count: number }[];
  attachmentCount: number;
  // Activity by year-month
  activityByMonth: { month: string; count: number }[];
  // Title history, ordered by firstSeen ASC. Length 1 when never renamed,
  // empty when conversation has no messages.
  titles: ConversationTitleHistory[];
  // Token usage + estimated API cost; null for sources without token
  // accounting or conversations with no usage-bearing assistant events.
  tokenUsage: ConversationTokenUsage | null;
}

// Insert zero-count entries for calendar months missing between the first and
// last bucket, so activity charts show gaps instead of splicing them out.
export function fillMonthGaps(buckets: { month: string; count: number }[]): { month: string; count: number }[] {
  if (buckets.length < 2) return buckets;
  const counts = new Map(buckets.map((b) => [b.month, b.count]));
  const toIndex = (month: string) => {
    const [y, m] = month.split("-").map(Number);
    return y * 12 + (m - 1);
  };
  const filled: { month: string; count: number }[] = [];
  const end = toIndex(buckets[buckets.length - 1].month);
  for (let i = toIndex(buckets[0].month); i <= end; i++) {
    const month = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
    filled.push({ month, count: counts.get(month) ?? 0 });
  }
  return filled;
}

/**
 * Get stats for a conversation
 */
export interface ConversationStatsOptions {
  conversationId: string;
  source: string;
  sourceAccount?: string;
  timing?: QueryTiming;
}

export async function getConversationStats(db: QueryExecutor, options: ConversationStatsOptions): Promise<ConversationStats> {
  const { conversationId, source, sourceAccount, timing } = options;

  const key = await withQueryTiming(
    timing,
    "conversation.stats.summary",
    "Conversation Summary Lookup",
    () => getConversationKey(db, source, conversationId, sourceAccount),
  );
  const filter = buildConversationFilter(key);

  const conditions = [filter.clause, "source = ?", conversationTypeClause()];
  const params: (string | number)[] = [filter.param, source];
  addSourceAccountCondition(conditions, params, key.sourceAccount);

  const whereClause = conditions.join(" AND ");

  const basicStats = key.summary
    ? {
      total: key.summary.messageCount,
      first_message: key.summary.firstMessage,
      last_message: key.summary.lastMessage,
    }
    : await withQueryTiming(
      timing,
      "conversation.stats.aggregate",
      "Conversation Summary Aggregate",
      () => db.get<{ total: number; first_message: string | null; last_message: string | null }>(`
        SELECT
          COUNT(*) as total,
          MIN(timestamp) as first_message,
          MAX(timestamp) as last_message
        FROM events
        WHERE ${whereClause}
      `, ...params),
    );

  // First/last message event ids — the anchors a "whole conversation" export
  // hands to exportConversationRange (which resolves the full span server-side).
  // Restricted to timestamped rows so they line up with first_message/last_message
  // and satisfy the range export's requirement that both endpoints have a timestamp.
  const { firstEvent, lastEvent } = await withQueryTiming(
    timing,
    "conversation.stats.bounds",
    "Conversation Event Bounds",
    async () => {
      const firstEvent = await db.get<{ id: number }>(`
        SELECT id FROM events
        WHERE ${whereClause} AND timestamp IS NOT NULL
        ORDER BY timestamp ASC, id ASC
        LIMIT 1
      `, ...params);
      const lastEvent = await db.get<{ id: number }>(`
        SELECT id FROM events
        WHERE ${whereClause} AND timestamp IS NOT NULL
        ORDER BY timestamp DESC, id DESC
        LIMIT 1
      `, ...params);
      return { firstEvent, lastEvent };
    },
  );

  // Participants with message counts
  const participantsRaw = await withQueryTiming(
    timing,
    "conversation.stats.participants",
    "Conversation Participant Counts",
    () => db.query<{ people: string; count: number }>(`
      SELECT people, COUNT(*) as count
      FROM events
      WHERE ${whereClause} AND people IS NOT NULL
      GROUP BY people
    `, ...params),
  );

  // Aggregate participants (people field is JSON array, usually with sender first)
  const participantCounts = new Map<string, number>();
  for (const row of participantsRaw) {
    try {
      const people = JSON.parse(row.people) as string[];
      const sender = people[0];
      if (sender) {
        participantCounts.set(sender, (participantCounts.get(sender) || 0) + row.count);
      }
    } catch {
      // Skip invalid JSON
    }
  }

  // Resolve participant identifiers to display names
  const identifiers = Array.from(participantCounts.keys());
  const resolved = await withQueryTiming(
    timing,
    "conversation.stats.identities",
    "Conversation Participant Identities",
    () => resolveIdentities(db, identifiers),
  );

  const participants = Array.from(participantCounts.entries())
    .map(([identifier, count]) => {
      const identity = resolved[identifier];
      // Use resolved name, or fall back to extracting from identifier
      let name = identity?.name || identity?.username;
      if (!name) {
        const parsed = parseIdentifier(identifier);
        if (parsed?.platformId?.startsWith("name:")) {
          name = parsed.platformId.slice("name:".length);
        } else {
          name = parsed?.platformId || identifier;
        }
      }
      return {
        identifier,
        name,
        contactId: identity?.contactId ?? null,
        avatarUrl: identity?.avatarUrl ?? null,
        count,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Attachment count
  const attachmentStats = await withQueryTiming(
    timing,
    "conversation.stats.attachments",
    "Conversation Attachment Count",
    () => db.get<{ count: number }>(`
      SELECT COUNT(*) as count
      FROM events
      WHERE ${whereClause} AND type LIKE '%:attachment'
    `, ...params),
  );

  // Activity by month
  const activityRows = await withQueryTiming(
    timing,
    "conversation.stats.activity",
    "Conversation Monthly Activity",
    () => db.query<{ month: string; count: number }>(`
      SELECT
        strftime('%Y-%m', timestamp) as month,
        COUNT(*) as count
      FROM events
      WHERE ${whereClause} AND timestamp IS NOT NULL
      GROUP BY month
      ORDER BY month
    `, ...params),
  );
  const activityByMonth = fillMonthGaps(activityRows);

  let titles: ConversationTitleHistory[] = [];
  if (key.summary) {
    const summary = key.summary;
    const titleRows = await withQueryTiming(
      timing,
      "conversation.stats.titles",
      "Conversation Title History",
      () => db.query<{ title: string; firstSeen: string; lastSeen: string; messageCount: number }>(`
        SELECT
          title,
          first_seen AS firstSeen,
          last_seen AS lastSeen,
          message_count AS messageCount
        FROM conversation_summary_titles
        WHERE source = ?
          AND source_account_key = ?
          AND conversation_id = ?
        ORDER BY first_seen ASC
      `, source, summary.sourceAccountKey, summary.conversationId),
    );
    titles = titleRows.map((r) => ({
      title: r.title,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      messageCount: r.messageCount,
    }));
  } else {
    const titleRows = await withQueryTiming(
      timing,
      "conversation.stats.titles",
      "Conversation Title History",
      () => db.query<{ title: string; first_seen: string; last_seen: string; count: number }>(`
        SELECT
          title,
          MIN(timestamp) as first_seen,
          MAX(timestamp) as last_seen,
          COUNT(*) as count
        FROM events
        WHERE ${whereClause} AND title IS NOT NULL AND timestamp IS NOT NULL
        GROUP BY title
        ORDER BY first_seen ASC
      `, ...params),
    );
    titles = titleRows.map((r) => ({
      title: r.title,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      messageCount: r.count,
    }));
  }

  let tokenUsage: ConversationTokenUsage | null = null;
  if (AI_USAGE_SOURCES.has(source)) {
    const usageRows = await withQueryTiming(
      timing,
      "conversation.stats.usage",
      "Conversation Token Usage",
      () => db.query<{ timestamp: string | null; usage_json: string | null }>(`
        SELECT timestamp, ${USAGE_EXTRACT_SQL} as usage_json
        FROM events
        WHERE ${whereClause} AND type LIKE '%:message:assistant' AND raw_data IS NOT NULL
      `, ...params),
    );

    const byModel = new Map<string, ConversationModelUsage>();
    for (const row of usageRows) {
      const usage = tokenUsageFromExtract(source, row.usage_json);
      if (!usage) continue;
      const model = usage.model ?? "unknown";
      let agg = byModel.get(model);
      if (!agg) {
        agg = { model, messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null };
        byModel.set(model, agg);
      }
      agg.messages += 1;
      agg.inputTokens += usage.inputTokens;
      agg.outputTokens += usage.outputTokens;
      agg.cacheReadTokens += usage.cacheReadTokens;
      agg.cacheCreationTokens += usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
      // Priced per message at the rates in effect at its timestamp, so
      // historical rate-card changes in MODEL_PRICING apply retroactively.
      const cost = estimateCostUsd(usage, row.timestamp);
      if (cost !== null) agg.costUsd = (agg.costUsd ?? 0) + cost;
    }

    if (byModel.size > 0) {
      const models = Array.from(byModel.values()).sort((a, b) => b.messages - a.messages);
      const pricedCosts = models.map((m) => m.costUsd).filter((c): c is number => c !== null);
      tokenUsage = {
        assistantMessages: models.reduce((sum, m) => sum + m.messages, 0),
        inputTokens: models.reduce((sum, m) => sum + m.inputTokens, 0),
        outputTokens: models.reduce((sum, m) => sum + m.outputTokens, 0),
        cacheReadTokens: models.reduce((sum, m) => sum + m.cacheReadTokens, 0),
        cacheCreationTokens: models.reduce((sum, m) => sum + m.cacheCreationTokens, 0),
        estimatedCostUsd: pricedCosts.length > 0 ? pricedCosts.reduce((sum, c) => sum + c, 0) : null,
        byModel: models,
      };
    }
  }

  return {
    totalMessages: basicStats?.total ?? 0,
    firstMessage: basicStats?.first_message ?? null,
    lastMessage: basicStats?.last_message ?? null,
    firstEventId: firstEvent?.id ?? null,
    lastEventId: lastEvent?.id ?? null,
    participants,
    attachmentCount: attachmentStats?.count ?? 0,
    activityByMonth,
    titles,
    tokenUsage,
  };
}

export interface ConversationMediaOptions {
  conversationId: string;
  source: string;
  sourceAccount?: string;
  mime?: string;  // Filter by MIME type prefix: "image", "video", "audio"
  limit?: number;
  cursor?: string;  // attachment ID for cursor-based pagination
  preferredDescriptionModels?: readonly string[];
}

export interface ConversationMediaAttachment {
  id: number;
  event_id: number;
  source: string;
  source_id: string | null;
  filename: string | null;
  mime_type: string | null;
  storage_path: string | null;
  status: string;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  file_size: number | null;
  duration_ms: number | null;
  description: string | null;
  timestamp: string;  // From the parent event, for date grouping
}

/**
 * Get media attachments for a conversation, paginated by attachment ID descending (newest first).
 */
export async function getConversationMedia(db: QueryExecutor, options: ConversationMediaOptions): Promise<ConversationMediaAttachment[]> {
  const { conversationId, source, sourceAccount, mime, limit = 60, cursor } = options;

  const key = await getConversationKey(db, source, conversationId, sourceAccount);
  const filter = buildConversationFilter(key, "e.");

  const conditions: string[] = [
    filter.clause,
    "e.source = ?",
    conversationTypeClause("e."),
    "e.type NOT LIKE '%sticker%'",
    "a.status = 'stored'",
    "a.storage_path IS NOT NULL",
  ];
  const params: (string | number)[] = [filter.param, source];
  addSourceAccountCondition(conditions, params, key.sourceAccount, "e.");

  if (mime) {
    conditions.push("a.mime_type LIKE ?");
    params.push(`${mime}/%`);
  }

  if (cursor) {
    conditions.push("a.id < ?");
    params.push(parseInt(cursor));
  }

  const descriptionSelect = latestAttachmentDescriptionSelect("ad.description", options.preferredDescriptionModels);
  const sql = `
    SELECT
      a.id, a.event_id, a.source, a.source_id, a.filename, a.mime_type,
      a.storage_path, a.status, a.width, a.height, a.thumbhash,
      a.file_size, a.duration_ms,
      ${descriptionSelect.sql} AS description,
      e.timestamp
    FROM attachments a
    JOIN events e ON a.event_id = e.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY a.id DESC
    LIMIT ?
  `;
  params.push(limit);

  return db.query<ConversationMediaAttachment>(sql, ...descriptionSelect.params, ...params);
}

export interface ConversationAroundOptions {
  conversationId: string;
  source: string;
  sourceAccount?: string;
  eventId: number;       // The event to center around
  before?: number;       // Number of messages before the event
  after?: number;        // Number of messages after the event
}

export interface ConversationAroundResult {
  events: TimelineEvent[];
  targetIndex: number;   // Index of the target event in the array
  hasBefore: boolean;    // Are there older messages?
  hasAfter: boolean;     // Are there newer messages?
  beforeCursor: string | null;  // Cursor for loading older messages
  afterCursor: string | null;   // Cursor for loading newer messages
}

/**
 * Get messages from a conversation around a specific event
 * Returns messages before and after the target event
 */
export async function getConversationAround(db: QueryExecutor, options: ConversationAroundOptions): Promise<ConversationAroundResult> {
  const { source, sourceAccount, conversationId, eventId, before = 50, after = 50 } = options;

  // First, get the target event to find its timestamp and conversation key
  const targetEvent = await db.get<TimelineEvent>(
    `SELECT events.*, ${versionCountSelect("events.")} FROM events WHERE id = ?`,
    eventId,
  );

  if (!targetEvent || !targetEvent.timestamp || targetEvent.source !== source || targetEvent.conversation_id !== conversationId) {
    return { events: [], targetIndex: -1, hasBefore: false, hasAfter: false, beforeCursor: null, afterCursor: null };
  }

  const filter = buildConversationFilter({ conversationId });
  const baseConditions = [filter.clause, "source = ?", conversationTypeClause()];
  const baseParams: (string | number)[] = [filter.param, source];
  addSourceAccountCondition(
    baseConditions,
    baseParams,
    sourceAccount !== undefined ? sourceAccount : targetEvent.source_account,
  );

  const whereBase = baseConditions.join(" AND ");

  // Get messages before (older than) the target, ordered DESC to get closest first, then reverse
  const beforeSql = `
    SELECT events.*, ${versionCountSelect("events.")} FROM events
    WHERE ${whereBase} AND (timestamp < ? OR (timestamp = ? AND id < ?))
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `;
  const beforeEvents = transformEvents(await db.query<TimelineEvent>(
    beforeSql, ...baseParams, targetEvent.timestamp, targetEvent.timestamp, eventId, before + 1
  ));

  const hasBefore = beforeEvents.length > before;
  if (hasBefore) beforeEvents.pop(); // Remove the extra one used for checking
  beforeEvents.reverse(); // Now oldest first

  // Get messages after (newer than) the target, ordered ASC
  const afterSql = `
    SELECT events.*, ${versionCountSelect("events.")} FROM events
    WHERE ${whereBase} AND (timestamp > ? OR (timestamp = ? AND id > ?))
    ORDER BY timestamp ASC, id ASC
    LIMIT ?
  `;
  const afterEvents = transformEvents(await db.query<TimelineEvent>(
    afterSql, ...baseParams, targetEvent.timestamp, targetEvent.timestamp, eventId, after + 1
  ));

  const hasAfter = afterEvents.length > after;
  if (hasAfter) afterEvents.pop(); // Remove the extra one

  // Combine: before + target + after
  const events = [...beforeEvents, transformEvent(targetEvent), ...afterEvents];
  const targetIndex = beforeEvents.length;

  // Generate cursors for pagination
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const beforeCursor = hasBefore && firstEvent ? createCursor(firstEvent) : null;
  const afterCursor = hasAfter && lastEvent ? createCursor(lastEvent) : null;

  return {
    events,
    targetIndex,
    hasBefore,
    hasAfter,
    beforeCursor,
    afterCursor,
  };
}
