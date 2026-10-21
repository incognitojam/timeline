import type { ContactWithStats } from "../db/contacts";
import type { QueryExecutor } from "../db/pool";
import { getAliasesForContact, listContacts } from "../db/queries";
import type { ContactAlias, TimelineEvent } from "../db/schema";
import { loadAttachmentDescriptionsForEvents } from "./attachment-descriptions";
import { resolveRenderIdentities } from "./display-names";
import { renderEvents } from "./render";
import { loadReplyQuotesForEvents } from "./reply-quotes";
import { countTokens } from "./tokens";

export interface ExportRenderOptions {
  source?: string;
  limit?: number;
  compactAuthors: boolean;
  noSummaries: boolean;
  fullTimestamps: boolean;
  preferredDescriptionModels?: readonly string[];
}

export interface ContactExportParams {
  names: string[];
}

export interface ContactExportOptions extends ExportRenderOptions {
  all: boolean;
  groupSize: number;
  contextHours: number;
  contextMessages: number;
}

export interface RangeExportParams {
  startDate: string;
  endDate: string;
}

export interface ConversationExportParams {
  conversationId: string;
  startDate?: string;
  endDate?: string;
}

export interface ConversationExportOptions extends ExportRenderOptions {
  /** Return the newest limited slice while rendering it chronologically. */
  mostRecent?: boolean;
  /** Include the pre-limit event count in the typed result. */
  includeTotal?: boolean;
  /** Center the limited result around this event, unless date bounds are set. */
  aroundEventId?: number;
}

export interface SourceTokenBreakdown {
  source: string;
  eventCount: number;
  tokenCount: number;
}

interface RenderedExportResult {
  events: TimelineEvent[];
  text: string | null;
  tokenCount: number | null;
}

export interface RangeExportResult extends RenderedExportResult {
  startDate: string;
  endDate: string;
}

export interface ConversationExportResult extends RenderedExportResult {
  conversationId: string;
  totalEventCount?: number;
}

export type ContactExportResult =
  | { kind: "not-found"; name: string; candidates: [] }
  | { kind: "ambiguous"; name: string; candidates: ContactWithStats[] }
  | {
      kind: "export";
      contact: ContactWithStats;
      aliases: ContactAlias[];
      aliasSources: string[];
      filtered: boolean;
      totalBeforeFilter: number;
      events: TimelineEvent[];
      text: string | null;
      tokenBreakdown: SourceTokenBreakdown[];
      tokenCount: number | null;
    };

/**
 * Get sender from people JSON array (first element)
 */
function getSender(people: string | null): string | null {
  if (!people) return null;
  try {
    const arr = JSON.parse(people);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr[0];
    }
  } catch {}
  return null;
}

/**
 * Count unique people in a people JSON array
 */
function countPeople(people: string | null): number {
  if (!people) return 0;
  try {
    const arr = JSON.parse(people);
    if (Array.isArray(arr)) {
      return new Set(arr).size;
    }
  } catch {}
  return 0;
}

/**
 * Filter events from large groups to only include relevant participation context
 */
export function filterLargeGroups(
  events: TimelineEvent[],
  relevantAliases: Set<string>,
  options: { groupSize: number; contextHours: number; contextMessages: number }
): TimelineEvent[] {
  const { groupSize, contextHours, contextMessages } = options;
  const contextMs = contextHours * 60 * 60 * 1000;

  // Group events by conversation (source + title)
  const conversations = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const key = `${event.source}|${event.title || ""}`;
    let conv = conversations.get(key);
    if (!conv) {
      conv = [];
      conversations.set(key, conv);
    }
    conv.push(event);
  }

  const result: TimelineEvent[] = [];

  for (const [_key, convEvents] of conversations) {
    // Check if this is a large group by counting unique people across all messages
    const allPeople = new Set<string>();
    for (const event of convEvents) {
      if (event.people) {
        try {
          const arr = JSON.parse(event.people);
          if (Array.isArray(arr)) arr.forEach((p: string) => allPeople.add(p));
        } catch {}
      }
    }

    // If small group, keep all messages
    if (allPeople.size < groupSize) {
      result.push(...convEvents);
      continue;
    }

    // Large group: find anchor messages where a relevant person sent
    const anchors: { index: number; timestamp: number }[] = [];
    for (let i = 0; i < convEvents.length; i++) {
      const sender = getSender(convEvents[i].people);
      if (sender && relevantAliases.has(sender)) {
        const rawTs = convEvents[i].timestamp;
        const ts = rawTs ? new Date(rawTs).getTime() : 0;
        anchors.push({ index: i, timestamp: ts });
      }
    }

    // If no anchors, skip this conversation entirely
    if (anchors.length === 0) continue;

    // For each message, check if within context of any anchor
    for (let i = 0; i < convEvents.length; i++) {
      const event = convEvents[i];
      const eventTs = event.timestamp ? new Date(event.timestamp).getTime() : 0;

      const isRelevant = anchors.some((anchor) => {
        // Before anchor: only message context (what they're responding to)
        if (i < anchor.index) {
          return anchor.index - i <= contextMessages;
        }
        // After anchor: message OR time context (conversation continues)
        const withinMessages = i - anchor.index <= contextMessages;
        const withinTime = eventTs - anchor.timestamp <= contextMs;
        return withinMessages || withinTime;
      });

      if (isRelevant) {
        result.push(event);
      }
    }
  }

  return result;
}

export async function exportContact(
  db: QueryExecutor,
  { names }: ContactExportParams,
  options: ContactExportOptions,
): Promise<ContactExportResult> {
  // First name is the export target, all names are "relevant" for filtering
  const primaryName = names[0];
  const matches = await listContacts(db, { search: primaryName });
  if (matches.length === 0) {
    return { kind: "not-found", name: primaryName, candidates: [] };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", name: primaryName, candidates: matches };
  }
  const contact = matches[0];
  const aliases = await getAliasesForContact(db, contact.id);

  // Collect aliases from the primary contact only for "relevant" filtering
  // (We only anchor on the contact's participation, not our own)
  const relevantAliases = new Set<string>();
  for (const a of aliases) {
    relevantAliases.add(a.alias);
  }

  // Get unique sources from primary contact's aliases
  const aliasSources = [...new Set(aliases.map((a) => a.source).filter((source): source is string => Boolean(source)))];

  // Build query using JOIN on event_people (handles large result sets efficiently)
  // For each alias, we need to match person and optionally source
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  for (const alias of aliases) {
    if (alias.source) {
      conditions.push(`(ep.person = ? AND ep.source = ?)`);
      params.push(alias.alias, alias.source);
    } else {
      conditions.push(`ep.person = ?`);
      params.push(alias.alias);
    }
  }

  let sql = `
    SELECT DISTINCT e.* FROM events e
    INNER JOIN event_people ep ON ep.event_id = e.id
    WHERE (${conditions.join(" OR ")})
  `;

  if (options.source) {
    sql += ` AND e.source = ?`;
    params.push(options.source);
  }

  sql += ` ORDER BY e.timestamp ASC`;

  if (options.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }

  let events = await db.query<TimelineEvent>(sql, ...params);
  const totalBeforeFilter = events.length;

  // Apply large group filtering unless --all is specified
  if (!options.all) {
    events = filterLargeGroups(events, relevantAliases, {
      groupSize: options.groupSize,
      contextHours: options.contextHours,
      contextMessages: options.contextMessages,
    });
  }

  if (events.length === 0) {
    return {
      kind: "export",
      contact,
      aliases,
      aliasSources,
      filtered: !options.all,
      totalBeforeFilter,
      events,
      text: null,
      tokenBreakdown: [],
      tokenCount: null,
    };
  }

  const attachmentDescriptions = await loadAttachmentDescriptionsForEvents(
    db,
    events,
    options.preferredDescriptionModels,
  );
  const renderIdentities = await resolveRenderIdentities(db, events);
  const replyQuotes = await loadReplyQuotesForEvents(db, events, {
    discordUserResolver: renderIdentities.discordUserResolver,
  });

  // Render all events with options
  const text = renderEvents(events, {
    compactAuthors: options.compactAuthors,
    noSummaries: options.noSummaries,
    fullTimestamps: options.fullTimestamps,
    dateHeaders: !options.fullTimestamps,
    attachmentDescriptions,
    replyQuotes,
    ...renderIdentities,
  });

  // Show breakdown by source (and sum tokens)
  const bySource = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const key = event.source;
    let group = bySource.get(key);
    if (!group) {
      group = [];
      bySource.set(key, group);
    }
    group.push(event);
  }

  let totalTokens = 0;
  const tokenBreakdown: SourceTokenBreakdown[] = [];
  for (const [source, sourceEvents] of bySource) {
    const sourceText = renderEvents(sourceEvents, {
      compactAuthors: options.compactAuthors,
      noSummaries: options.noSummaries,
      fullTimestamps: options.fullTimestamps,
      dateHeaders: !options.fullTimestamps,
      attachmentDescriptions,
      replyQuotes,
      ...renderIdentities,
    });
    const tokens = countTokens(sourceText);
    totalTokens += tokens;
    tokenBreakdown.push({ source, eventCount: sourceEvents.length, tokenCount: tokens });
  }

  return {
    kind: "export",
    contact,
    aliases,
    aliasSources,
    filtered: !options.all,
    totalBeforeFilter,
    events,
    text,
    tokenBreakdown,
    tokenCount: totalTokens,
  };
}

export async function exportRange(
  db: QueryExecutor,
  { startDate, endDate }: RangeExportParams,
  options: ExportRenderOptions,
): Promise<RangeExportResult> {
  // Query events in the date range
  const sql = `
    SELECT * FROM events
    WHERE timestamp >= ? AND timestamp < ?
    ${options.source ? "AND source = ?" : ""}
    ORDER BY timestamp ASC
    ${options.limit ? `LIMIT ${options.limit}` : ""}
  `;

  const params = options.source
    ? [startDate, endDate, options.source]
    : [startDate, endDate];

  const events = await db.query<TimelineEvent>(sql, ...params);

  if (events.length === 0) {
    return { startDate, endDate, events, text: null, tokenCount: null };
  }

  const attachmentDescriptions = await loadAttachmentDescriptionsForEvents(
    db,
    events,
    options.preferredDescriptionModels,
  );
  const renderIdentities = await resolveRenderIdentities(db, events);
  const replyQuotes = await loadReplyQuotesForEvents(db, events, {
    discordUserResolver: renderIdentities.discordUserResolver,
  });
  const text = renderEvents(events, {
    compactAuthors: options.compactAuthors,
    noSummaries: options.noSummaries,
    fullTimestamps: options.fullTimestamps,
    dateHeaders: !options.fullTimestamps,
    attachmentDescriptions,
    replyQuotes,
    ...renderIdentities,
  });
  const tokenCount = countTokens(text);

  return { startDate, endDate, events, text, tokenCount };
}

export async function exportConversation(
  db: QueryExecutor,
  { conversationId, startDate, endDate }: ConversationExportParams,
  options: ConversationExportOptions,
): Promise<ConversationExportResult> {
  const params: unknown[] = [conversationId];
  const whereConditions = ["conversation_id = ?"];
  if (options.source) {
    whereConditions.push("source = ?");
    params.push(options.source);
  }
  if (startDate) {
    whereConditions.push("timestamp >= ?");
    params.push(startDate);
  }
  if (endDate) {
    whereConditions.push("timestamp <= ?");
    params.push(endDate);
  }

  const whereClause = whereConditions.join(" AND ");

  const totalEventCount = options.includeTotal
    ? (await db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM events WHERE ${whereClause}`,
      ...params,
    ))?.count ?? 0
    : undefined;

  const shouldCenterOnEvent = options.aroundEventId !== undefined && !startDate && !endDate;
  if (shouldCenterOnEvent) {
    const anchor = await db.get<TimelineEvent>(
      `SELECT * FROM events WHERE ${whereClause} AND id = ?`,
      ...params,
      options.aroundEventId,
    );
    if (!anchor) {
      throw new Error(`Event ${options.aroundEventId} is not in conversation ${conversationId}`);
    }

    const sideLimit = Math.max((options.limit ?? 0) - 1, 0);
    if (sideLimit === 0) {
      return renderConversationResult(db, conversationId, [anchor], options, totalEventCount);
    }

    const beforeAnchorCondition = anchor.timestamp === null
      ? "timestamp IS NULL AND id < ?"
      : "(timestamp IS NULL OR timestamp < ? OR (timestamp = ? AND id < ?))";
    const beforeAnchorParams = anchor.timestamp === null
      ? [anchor.id]
      : [anchor.timestamp, anchor.timestamp, anchor.id];
    const afterAnchorCondition = anchor.timestamp === null
      ? "(timestamp IS NOT NULL OR (timestamp IS NULL AND id > ?))"
      : "(timestamp > ? OR (timestamp = ? AND id > ?))";
    const afterAnchorParams = anchor.timestamp === null
      ? [anchor.id]
      : [anchor.timestamp, anchor.timestamp, anchor.id];

    const before = await db.query<TimelineEvent>(`
      SELECT * FROM events
      WHERE ${whereClause} AND ${beforeAnchorCondition}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `, ...params, ...beforeAnchorParams, sideLimit);
    const after = await db.query<TimelineEvent>(`
      SELECT * FROM events
      WHERE ${whereClause} AND ${afterAnchorCondition}
      ORDER BY timestamp ASC, id ASC
      LIMIT ?
    `, ...params, ...afterAnchorParams, sideLimit);

    const desiredBefore = Math.floor(sideLimit / 2);
    const desiredAfter = sideLimit - desiredBefore;
    let beforeCount = Math.min(desiredBefore, before.length);
    let afterCount = Math.min(desiredAfter, after.length);
    let remaining = sideLimit - beforeCount - afterCount;

    const extraAfter = Math.min(remaining, after.length - afterCount);
    afterCount += extraAfter;
    remaining -= extraAfter;
    beforeCount += Math.min(remaining, before.length - beforeCount);

    const events = [
      ...before.slice(0, beforeCount).reverse(),
      anchor,
      ...after.slice(0, afterCount),
    ];
    return renderConversationResult(db, conversationId, events, options, totalEventCount);
  }

  let sql = `
    SELECT * FROM events
    WHERE ${whereClause}
    ORDER BY timestamp ${options.mostRecent && options.limit ? "DESC" : "ASC"}
  `;
  if (options.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const events = await db.query<TimelineEvent>(sql, ...params);
  if (options.mostRecent && options.limit) {
    events.reverse();
  }

  return renderConversationResult(db, conversationId, events, options, totalEventCount);
}

async function renderConversationResult(
  db: QueryExecutor,
  conversationId: string,
  events: TimelineEvent[],
  options: ExportRenderOptions,
  totalEventCount: number | undefined,
): Promise<ConversationExportResult> {
  if (events.length === 0) {
    return { conversationId, events, text: null, tokenCount: null, totalEventCount };
  }

  const attachmentDescriptions = await loadAttachmentDescriptionsForEvents(
    db,
    events,
    options.preferredDescriptionModels,
  );
  const renderIdentities = await resolveRenderIdentities(db, events);
  const replyQuotes = await loadReplyQuotesForEvents(db, events, {
    discordUserResolver: renderIdentities.discordUserResolver,
  });
  const text = renderEvents(events, {
    compactAuthors: options.compactAuthors,
    noSummaries: options.noSummaries,
    fullTimestamps: options.fullTimestamps,
    dateHeaders: !options.fullTimestamps,
    attachmentDescriptions,
    replyQuotes,
    ...renderIdentities,
  });
  const tokenCount = countTokens(text);

  return { conversationId, events, text, tokenCount, totalEventCount };
}
