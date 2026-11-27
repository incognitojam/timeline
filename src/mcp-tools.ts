/**
 * MCP Tools Registration
 *
 * Shared tool definitions for both stdio and HTTP MCP transports.
 * Tools: get_updates, search_mcp_tool_calls, query_events,
 *        export_conversation, get_context, get_schema, run_sql, list_contacts,
 *        get_contact_info, semantic_search, list_memory, get_memory_note,
 *        save_memory_note, delete_memory_note
 */

import type { Database } from "bun:sqlite";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, RequestId, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAppStateDb } from "./db/app-state";
import {
  checkNewMemoryNote,
  deleteMemoryNote,
  getMemoryNote,
  listContactMemoryNotes,
  listMemoryNotes,
  MEMORY_LIMITS,
  projectScope,
  projectUsesAccountMemory,
  saveMemoryNote,
} from "./db/memory-notes";
import { MEMORY_KINDS } from "./shared/memory";
import { resolveIdentities } from "./db/identities";
import type { QueryExecutor } from "./db/pool";
import {
  contactEventGroups,
  countContactEvents,
  createCursor,
  getAliasesForContact,
  getContact,
  getContactMemories,
  getEventContext,
  getEvents,
  getIdentitiesForContact,
  getRawDataSchema,
  getRecentEvents,
  hasHiddenContacts,
  hiddenEventIdsSubquery,
  hydrateEventsById,
  invalidateHiddenClauseCaches,
  listContacts,
  listSources,
  parseCursor,
  runReadOnlySql,
  searchByContact,
  searchByLocation,
  searchTimeline,
  searchTimelineGroups,
} from "./db/queries";
import type { EventGroup } from "./db/queries";
import type { TimelineEvent } from "./db/schema";
import { notConfiguredMessage } from "./embeddings/config";
import { formatWindowHit, type SemanticSearch, searchEmbeddingsWithWindows } from "./embeddings/search";
import { exportConversation, renderExportText } from "./export/export";
import { maskForwardsOfHiddenEvents } from "./export/hidden-forwards";
import { countTokens } from "./export/tokens";
import {
  getAttachmentDescription,
  getMessageMarkers,
} from "./lib/format";
import {
  DEFAULT_MCP_ARGS_EXCERPT_CHARS,
  DEFAULT_MCP_RESULT_EXCERPT_CHARS,
  renderMcpCallSearchMarkdown,
  renderMcpSessionHeader,
  renderMcpSessionListMarkdown,
} from "./mcp/render";
import {
  getMcpSession,
  getMcpSessionStats,
  listMcpSessions,
  MCP_TOOL_CALL_SINCE_ERROR,
  normalizeMcpToolCallSince,
  searchMcpToolCalls,
} from "./mcp/recording";
import { memoryInstructions, renderMemoryIndex, renderMemoryNote } from "./mcp/memory";
import { badDate, filterError, typeFilter, unknownSource, unknownType, utcBound } from "./mcp/filters";
import { renderSchemaOverview } from "./mcp/schema";
import {
  HIDDEN_CONTACT_NAME,
  HIDDEN_CONTACTS_NOTE,
  hiddenContactIds,
  withoutHiddenContactEvents,
  withoutHiddenWindows,
} from "./mcp/hidden-contacts";
import { GET_UPDATES_DESCRIPTION, GET_UPDATES_SCHEMA, runGetUpdates } from "./mcp/updates";
import { getDiscordComponentsText } from "./platforms/discord/shared/components";
import { isConversationEventType } from "./shared/grouping";
import { NOISY_MACHINE_SOURCES } from "./shared/noisy-sources";
import { discordMentionsToPlainText, extractUserMentionIds } from "./platforms/discord/shared/mentions";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MCP_EXPORT_LIMIT = 500;

/** The most events query_events and get_context return at once; 500 compact lines already fill most of a reply. */
const MAX_EVENT_LIMIT = 500;

/**
 * Characters a reply may hold: under Claude Code's 50,000, past which it moves
 * a result to a file, and claude.ai's ~150,000 cap; event lines run about 3
 * characters a token, so also well under Claude Code's 25,000-token cap.
 */
export const REPLY_CHAR_BUDGET = 40_000;

/**
 * The reply for as many of `count` items as fit the budget: at least one, which
 * cutToBudget may still cut. `reply(n)` renders the first n, and grows with n.
 */
async function fitReply(count: number, reply: (n: number) => string | Promise<string>): Promise<string> {
  const all = await reply(count);
  if (count <= 1 || all.length <= REPLY_CHAR_BUDGET) return all;
  let fits = 1;
  let best = await reply(1);
  let over = count;
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    const text = await reply(mid);
    if (text.length <= REPLY_CHAR_BUDGET) [fits, best] = [mid, text];
    else over = mid;
  }
  return best;
}

/** A reply still over the budget (one long item) is cut, saying so. Every tool here replies with one text part. */
function cutToBudget(result: CallToolResult): CallToolResult {
  const [part] = result.content;
  if (result.content.length !== 1 || part.type !== "text" || part.text.length <= REPLY_CHAR_BUDGET) return result;
  const note = `\n[Reply cut at ${REPLY_CHAR_BUDGET.toLocaleString("en-US")} characters; ask for less.]`;
  return { ...result, content: [{ ...part, text: part.text.slice(0, REPLY_CHAR_BUDGET - note.length) + note }] };
}

/** A contact's events are counted up to here; past it the header says "more than". */
const CONTACT_COUNT_CAP = 10_000;

type PageOrder = "oldest first" | "newest first";

/**
 * Trim a fetch of `limit + 1` events to `limit` and describe the page in one
 * line: how many are shown (and of how many, when counted), which end of the
 * matches they are, and what to pass for the next page. `filter` drops events
 * after the fetch; the cursor still continues from the last one fetched.
 */
function pageOf(
  fetched: TimelineEvent[],
  limit: number,
  order: PageOrder,
  options: {
    total?: number;
    pageable?: boolean;
    /** The query pages past events with no timestamp (searchTimeline and searchByContact do). */
    untimedCursor?: boolean;
    filter?: (event: TimelineEvent) => boolean;
    /** The reply's size, not limit, ended the page. */
    cut?: boolean;
  } = {},
): { events: TimelineEvent[]; header: string } {
  const kept = fetched.slice(0, limit);
  const events = options.filter ? kept.filter(options.filter) : kept;
  const more = fetched.length > limit;
  if (events.length === 0 && !more) return { events, header: "" };
  const { total } = options;
  const of = total === undefined
    ? ""
    : total > CONTACT_COUNT_CAP
      ? ` of more than ${CONTACT_COUNT_CAP.toLocaleString("en-US")}`
      : ` of ${total.toLocaleString("en-US")}`;
  const shown = `${events.length}${of} event${(total ?? events.length) === 1 ? "" : "s"}`;
  if (!more) {
    const header = total !== undefined && total > events.length
      ? `Showing ${shown}, ${order}; this is the last page.`
      : `${shown}, ${order}.`;
    return { events, header: `${header}\n` };
  }
  const last = kept[kept.length - 1];
  const cursor = options.pageable === false || !last
    ? null
    : options.untimedCursor ? createCursor(last, { allowNullTimestamp: true }) : createCursor(last);
  // A filter after the fetch may have dropped every remaining match.
  const next = cursor
    ? `Next page: the same arguments with cursor: "${cursor}".`
    : `More ${options.filter ? "may match" : "exist"}: narrow the filters${options.cut ? "" : " or raise limit"}.`;
  return { events, header: `Showing ${shown}, ${order}. ${next}\n` };
}

type PageOptions = NonNullable<Parameters<typeof pageOf>[3]>;

/**
 * A page of events as a reply: `prefix`, the page line, the events. Past the
 * budget it ends the page at the last event that fits, and repeats the page
 * line at the end, where the reply stops.
 */
async function eventReply(
  db: QueryExecutor,
  fetched: TimelineEvent[],
  limit: number,
  order: PageOrder,
  options: PageOptions,
  fullContent: boolean,
  prefix: string,
  none = "No events found.",
): Promise<CallToolResult> {
  const full = pageOf(fetched, limit, order, options);
  const pageOfSize = (n: number) => n === full.events.length
    ? full
    : pageOf(fetched, fetched.indexOf(full.events[n - 1]) + 1, order, { ...options, cut: true });
  const render = async (n: number) => {
    const page = pageOfSize(n);
    const end = n < full.events.length ? `\n${page.header}` : "";
    const events = page.events.length === 0 && !page.header ? none : await formatEvents(db, page.events, fullContent);
    return prefix + page.header + events + end;
  };
  const text = await fitReply(full.events.length, render);
  return { content: [{ type: "text" as const, text }] };
}

const cursorParam = z.string().optional().describe('From a "Next page" line');

const badCursor = (cursor: string): CallToolResult =>
  ({ isError: true, content: [{ type: "text" as const, text: `Error: invalid cursor "${cursor}"; pass one exactly as a "Next page" line gave it.` }] });

function invalidCursor(cursor: string | undefined): CallToolResult | null {
  return cursor !== undefined && !parseCursor(cursor, { allowNullTimestamp: true }) ? badCursor(cursor) : null;
}

function withTranscriptMetadata(metadata: string[], transcript: string | null): string {
  return ["Times in UTC.", ...metadata, "", transcript ?? "No events found."].join("\n");
}

function expandEndDateToEndOfDay(value: string | undefined): string | undefined {
  return value?.length === 10 ? `${value}T23:59:59.999Z` : value;
}

function formatBirthdayForDisplay(value: string): string {
  if (value.startsWith("--")) {
    const month = parseInt(value.slice(2, 4), 10);
    const day = parseInt(value.slice(5, 7), 10);
    return `${day} ${MONTH_NAMES[month - 1]}`;
  }
  const [y, m, d] = value.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

function formatRunSqlTimeout(timeoutMs: number): string {
  return [
    `Error: Database query timeout after ${timeoutMs}ms`,
    "",
    "The Timeline server stopped waiting for this database query; the connection is fine. The query is still executing server-side, so do not retry it unchanged: that would queue another scan and slow other callers. Narrow it instead.",
    "",
    "Tips:",
    "- Lead with `source`; a `source` plus `timestamp` filter (and `ORDER BY timestamp`) matches an events index.",
    "- Add `type` when known; `source` plus `type` matches another events index.",
    "- For conversation events, include `source`, `source_account`, `title`, and the matching `type` before ordering by `timestamp`.",
    "- Use export_conversation rather than run_sql to read a conversation transcript.",
    "- Avoid `json_extract()` in a `WHERE` clause until other predicates have narrowed the row set.",
  ].join("\n");
}

function messageContent(event: TimelineEvent): string | null {
  return event.content
    || (event.source === "discord" ? getDiscordComponentsText(event.raw_data) : null);
}

/** The UTC day and HH:MM an event is listed under; offset timestamps are converted. */
function utcDayAndTime(timestamp: string | null): { day: string; time: string } {
  if (!timestamp) return { day: "undated", time: "" };
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return { day: "undated", time: timestamp };
  const iso = date.toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
}

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, " / ");

/**
 * Shorten a preview to `max` characters on one line, so every event stays one
 * line. Full text keeps its lines, indented so none reads as an event or run.
 */
function preview(text: string, max: number, full: boolean): string {
  if (full) return text.replace(/\n/g, "\n    ");
  const line = oneLine(text);
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

/**
 * Format events for display, grouped the way the export renderer groups a
 * transcript: a `## <UTC day>` line, then a `[source/type]` line (for
 * conversation events, `[source] <conversation>`) for each run of events that
 * share it, then one `HH:MM #<id> ...` line per event. Resolves the sender
 * (people[0]) for every conversation event and Discord <@id> mentions in
 * content via a single batched identities lookup, so the LLM sees
 * `<Alice Example>` and `@Alice Example` instead of raw IDs.
 */
export async function formatEvents(
  db: QueryExecutor,
  listed: TimelineEvent[],
  fullContent = false
): Promise<string> {
  if (listed.length === 0) {
    return "No events found.";
  }
  const { events } = await maskForwardsOfHiddenEvents(db, listed);

  // Collect every identifier we may need to resolve.
  const identifiers = new Set<string>();
  for (const e of events) {
    if (e.people) {
      try {
        const people: string[] = JSON.parse(e.people);
        if (people[0]) identifiers.add(people[0]);
      } catch {}
    }
    const discordText = e.source === "discord" ? messageContent(e) : null;
    if (discordText) {
      for (const id of extractUserMentionIds(discordText)) {
        identifiers.add(`discord:${id}`);
      }
    }
  }

  const resolved = identifiers.size > 0
    ? await resolveIdentities(db, [...identifiers])
    : {};

  // A hidden contact's name is not shown, even where a visible message mentions them.
  const discordUserResolver = (id: string): string | null =>
    resolved[`discord:${id}`]?.hidden ? HIDDEN_CONTACT_NAME : resolved[`discord:${id}`]?.name ?? null;

  const lines = ["Times in UTC."];
  let day: string | undefined;
  let run: string | undefined;
  for (const e of events) {
    const { runLine, parts } = isConversationEventType(e.type)
      ? conversationEventLine(e, resolved, discordUserResolver, fullContent)
      : otherEventLine(e, fullContent);
    if (e.location_name) {
      parts.push(`@ ${e.location_name}`);
    }

    const at = utcDayAndTime(e.timestamp);
    if (at.day !== day) {
      lines.push(`## ${at.day}`);
      day = at.day;
      run = undefined;
    }
    if (runLine !== run) {
      lines.push(runLine);
      run = runLine;
    }
    lines.push([at.time, `#${e.id}`, ...parts].filter(Boolean).join(" "));
  }
  return lines.join("\n");
}

type EventLine = { runLine: string; parts: string[] };

/** A message, text or call: `[source] <conversation>` heads the run; the line is `<sender> text` (`<type> text` for texts and calls). */
function conversationEventLine(
  e: TimelineEvent,
  resolved: Awaited<ReturnType<typeof resolveIdentities>>,
  discordUserResolver: (id: string) => string | null,
  fullContent: boolean,
): EventLine {
  let people: string[] = [];
  try {
    if (e.people) people = JSON.parse(e.people);
  } catch {}

  const sender = people[0];
  const attachments = getAttachmentDescription(e);
  const markers = getMessageMarkers(e, attachments);
  const content = messageContent(e);
  const rawText = content && markers.length > 0
    ? `${content} ${markers.join(" ")}`
    : content || markers.join(" ");
  // Resolve <@id> / <#id> / <:emoji:id> in Discord content before truncation.
  const text = rawText && e.source === "discord"
    ? discordMentionsToPlainText(rawText, e.raw_data, { user: discordUserResolver })
    : rawText;

  // The title names the conversation, except in legacy Facebook data that
  // stored the message in title.
  const titleIsContent = e.source === "facebook" && e.title && e.content &&
    (e.title === e.content || e.content.startsWith(e.title.replace(/\.\.\.$/,'')) || e.title.startsWith(e.content.slice(0, 50)));
  const parts: string[] = [];
  // Only messages list their sender first; for texts and calls the type says
  // which way it went (sms:sent, sms:failed, call:missed).
  if (!e.type.includes("message")) {
    parts.push(e.type);
  } else if (sender) {
    const senderName = resolved[sender]?.name;
    parts.push(senderName ? `<${senderName}>` : `<${sender}>`);
  }
  if (text) parts.push(preview(text, 150, fullContent));
  return { runLine: e.title && !titleIsContent ? `[${e.source}] ${e.title}` : `[${e.source}]`, parts };
}

/** Anything else: `[source/type]` heads the run; the line is `title - content`. */
function otherEventLine(e: TimelineEvent, fullContent: boolean): EventLine {
  // Some sources (Spotify) repeat the title as the content's first words.
  const content = e.content && e.content !== e.title ? e.content : null;
  const title = e.title && !content?.startsWith(`${e.title} `) ? oneLine(e.title) : null;
  const parts: string[] = [];
  if (title) parts.push(title);
  if (content) parts.push(`${title ? "- " : ""}${preview(content, 100, fullContent)}`);
  return { runLine: `[${e.source}/${e.type}]`, parts };
}

const groupParam = z.boolean().optional().describe("Instead of events, one line per conversation: hits, dates, an #id");

type HitGroup = Pick<EventGroup, "source" | "conversation_id" | "type" | "title" | "hits" | "first" | "last" | "example_id">;

/** `[source] <conversation>: N hits, first to last day, <example> #id` per group. */
function formatGroups(groups: HitGroup[], example: string): string {
  return groups.map((g) => {
    const label = g.conversation_id ? `[${g.source}] ${g.title ?? g.conversation_id}:` : `[${g.source}/${g.type}]`;
    const first = utcDayAndTime(g.first).day;
    const last = utcDayAndTime(g.last).day;
    const span = first === last ? first : `${first} to ${last}`;
    return `${label} ${g.hits} hit${g.hits === 1 ? "" : "s"}, ${span}, ${example} #${g.example_id}`;
  }).join("\n");
}

/** Group events (in rank order) as groupEvents does in SQL; each group's example is its first event. */
function groupByConversation(events: TimelineEvent[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const e of events) {
    const key = JSON.stringify(e.conversation_id === null
      ? [e.source, e.type]
      : [e.source, e.source_account, e.conversation_id]);
    const group = groups.get(key);
    if (!group) {
      const { source, conversation_id, type, title, timestamp, id } = e;
      groups.set(key, { source, conversation_id, type, title, hits: 1, first: timestamp, last: timestamp, example_id: id });
      continue;
    }
    group.hits++;
    if (e.timestamp && (!group.first || e.timestamp < group.first)) group.first = e.timestamp;
    if (e.timestamp && (!group.last || e.timestamp > group.last)) group.last = e.timestamp;
  }
  return [...groups.values()];
}

const READ_GROUP = "Read a conversation with export_conversation(event_id: <#id>); see around any other #id with get_context.";

/** query_events for a contact: their events, counted, with the cursor for the next page. */
async function contactQueryEvents(
  db: QueryExecutor,
  contact: string,
  params: {
    query?: string; source?: string; type?: string; location?: string; cursor?: string; limit: number;
    order: PageOrder; excludeSources?: string[]; startDate?: string; endDate?: string;
  },
  respond: (fetched: TimelineEvent[], order: PageOrder, options: PageOptions, prefix: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const { query, source, type, location, cursor, limit, order, excludeSources, startDate, endDate } = params;
  const resolved = await resolveContact(db, contact);
  if (resolved.error) {
    return { content: resolved.error, isError: true };
  }

  const aliases = await getAliasesForContact(db, resolved.contact.id);
  const filters = { query, source, type, startDate, endDate, excludeSources, excludeHidden: true };
  const fetched = await searchByContact(db, resolved.contact.id, { ...filters, cursor, limit: limit + 1 });
  // The location filter runs after the fetch, so the count would not match it.
  const total = location
    ? undefined
    : await countContactEvents(db, resolved.contact.id, filters, CONTACT_COUNT_CAP + 1);
  const lowerLoc = location?.toLowerCase();
  const pageOptions: PageOptions = {
    total,
    untimedCursor: true,
    filter: lowerLoc ? (e) => e.location_name?.toLowerCase().includes(lowerLoc) ?? false : undefined,
  };

  const header = [
    `Contact: ${resolved.contact.display_name} (ID: ${resolved.contact.id})`,
    `Aliases: ${aliases.map((a) => a.source ? `${a.alias} (${a.source})` : a.alias).join(", ") || "none"}`,
    "",
  ].join("\n");

  return respond(fetched, order, pageOptions, header);
}

/** query_events with group_by_conversation: its matches grouped in SQL, most hits first. */
async function groupedQueryEvents(
  db: QueryExecutor,
  params: {
    query?: string; source?: string; type?: string; contact?: string; location?: string; latitude?: number;
    longitude?: number; cursor?: string; startDate?: string; endDate?: string; limit: number;
    excludeSources?: string[]; notice: string; none: string;
  },
): Promise<CallToolResult> {
  const { query, source, type, contact, startDate, endDate, excludeSources, limit } = params;
  const refuse = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${text}` }] });
  if (params.location || params.latitude !== undefined || params.longitude !== undefined) {
    return refuse("group_by_conversation does not combine with location or coordinates.");
  }
  if (params.cursor) return refuse("group_by_conversation lists every group at once; it takes no cursor.");
  if (!query && !source && !type && !contact && !startDate && !endDate) {
    return refuse("group_by_conversation needs a query, contact, source, type or date filter.");
  }
  const filters = { query, source, type, startDate, endDate, excludeSources };
  let prefix = params.notice;
  let groups: EventGroup[];
  if (contact) {
    const resolved = await resolveContact(db, contact);
    if (resolved.error) return { content: resolved.error, isError: true };
    prefix = `Contact: ${resolved.contact.display_name} (ID: ${resolved.contact.id})\n${prefix}`;
    groups = await contactEventGroups(db, resolved.contact.id, { ...filters, excludeHidden: true }, limit);
  } else {
    groups = await searchTimelineGroups(db, filters, limit);
  }
  if (groups.length === 0) return { content: [{ type: "text" as const, text: `${prefix}${params.none}` }] };

  const { groups: groupCount, total_hits: totalHits } = groups[0];
  const shown = groupCount > groups.length ? ` Showing the ${groups.length} with most hits; raise limit for the rest.` : "";
  const header = `Times in UTC. ${totalHits} hit${totalHits === 1 ? "" : "s"} in ${groupCount} group${groupCount === 1 ? "" : "s"}, most hits first.${shown} ${READ_GROUP}`;
  const text = await fitReply(groups.length, (n) => {
    const cut = n < groups.length
      ? `\nShowing ${n} of ${groupCount} groups; the rest did not fit in one reply. Narrow the filters.`
      : "";
    return `${prefix}${header}\n${formatGroups(groups.slice(0, n), "newest")}${cut}`;
  });
  return { content: [{ type: "text" as const, text }] };
}

// TSV helpers for run_sql output
const escapeTSV = (val: unknown): string => {
  if (val === null || val === undefined) return "";
  return String(val)
    .replace(/\\/g, "\\\\") // escape backslashes first
    .replace(/\t/g, "\\t")  // escape tabs
    .replace(/\n/g, "\\n")  // escape newlines
    .replace(/\r/g, "\\r"); // escape carriage returns
};

const EXCLUDE_COLUMNS = new Set(["raw_data", "source_id", "import_batch"]);

function toTSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no results)";

  const columns = Object.keys(rows[0]).filter(col => !EXCLUDE_COLUMNS.has(col));
  const tsvRows = rows.map(row =>
    columns.map(col => escapeTSV(row[col])).join("\t")
  );

  return [columns.join("\t"), ...tsvRows].join("\n");
}

/**
 * Look up a contact by a platform identifier (Discord snowflake, phone number,
 * `discord:ID`, `facebook:name:Name`, etc.). Used as a fallback in resolveContact
 * so callers can pass raw IDs they pulled out of message content.
 *
 * Returns:
 *   - { contactId } if exactly one linked contact matches
 *   - { ambiguous } if the same identifier links to multiple distinct contacts
 *   - null if no linked identity matches
 */
async function resolveContactByIdentity(
  db: QueryExecutor,
  input: string,
): Promise<
  | { contactId: number }
  | { ambiguous: { platform: string; platform_id: string; contact_id: number; contact_name: string }[] }
  | null
> {
  // Form 1: explicit "platform:platform_id" (e.g. "discord:900…", "phone:+44…").
  // Uses the existing composite (platform, platform_id) unique index.
  if (input.includes(":")) {
    const identity = (await resolveIdentities(db, [input]))[input];
    return identity?.contactId != null && !identity.hidden ? { contactId: identity.contactId } : null;
  }

  // Form 2: bare platform_id (e.g. "900000000000000001"). Probes the
  // idx_identities_platform_id index without needing to know the platform.
  const rows = await db.query<{
    platform: string;
    platform_id: string;
    contact_id: number;
    contact_name: string;
  }>(
    `SELECT i.platform, i.platform_id, i.contact_id, c.display_name AS contact_name
     FROM identities i
     JOIN contacts c ON c.id = i.contact_id
     WHERE i.platform_id = ? AND c.hidden = 0
     LIMIT 10`,
    input,
  );

  if (rows.length === 0) return null;

  const uniqueContactIds = new Set(rows.map((r) => r.contact_id));
  if (uniqueContactIds.size === 1) {
    return { contactId: rows[0].contact_id };
  }
  return { ambiguous: rows.slice(0, 5) };
}

/**
 * Resolve a contact by ID, name, or platform identifier. Returns the contact
 * object or an error response. Deduplicates the contact resolution logic used
 * across multiple tools.
 */
export async function resolveContact(
  db: QueryExecutor,
  contact: string,
): Promise<
  | { contact: Awaited<ReturnType<typeof getContact>> & {}; error?: never }
  | { contact?: never; error: { type: "text"; text: string }[] }
> {
  let contactObj = null;
  const contactId = parseInt(contact);

  // Round-tripping through String catches lossy parseInt outcomes (e.g. a
  // Discord snowflake exceeding MAX_SAFE_INTEGER) — those should fall through
  // to identity lookup rather than match a phantom contact.
  // A hidden contact matches nothing here, so asking for one reads exactly as
  // asking for someone unknown.
  if (!isNaN(contactId) && String(contactId) === contact) {
    const byId = await getContact(db, contactId);
    if (byId && !byId.hidden) contactObj = byId;
  }

  if (!contactObj) {
    const contacts = await listContacts(db, { search: contact });
    if (contacts.length === 1) {
      contactObj = contacts[0];
    } else if (contacts.length > 1) {
      const lines = contacts.slice(0, 5).map((c) => `${c.id}. ${c.display_name}`);
      return {
        error: [{
          type: "text" as const,
          text: `Multiple contacts match "${contact}". Please specify by ID:\n${lines.join("\n")}`,
        }],
      };
    }
  }

  // Fallback: treat the input as a platform identifier (e.g. Discord snowflake).
  if (!contactObj) {
    const identity = await resolveContactByIdentity(db, contact);
    if (identity && "ambiguous" in identity) {
      const lines = identity.ambiguous.map((r) => `${r.contact_id}. ${r.contact_name} (${r.platform}:${r.platform_id})`);
      return {
        error: [{
          type: "text" as const,
          text: `Identifier "${contact}" matches multiple contacts. Please specify by ID:\n${lines.join("\n")}`,
        }],
      };
    }
    if (identity && "contactId" in identity) {
      contactObj = await getContact(db, identity.contactId);
    }
  }

  if (!contactObj) {
    return {
      error: [{ type: "text" as const, text: `Contact "${contact}" not found. Try list_contacts(search: …) with part of the name.` }],
    };
  }
  return { contact: contactObj };
}

/**
 * The instructions an MCP server returns at initialise: what the event ids in
 * tool output are for, then the shared memory.
 */
export function mcpInstructions(
  appStateDb: Database,
  options: { publicUrl?: string; readOnly?: boolean; hiddenContactIds?: ReadonlySet<number> } = {},
): string {
  const url = options.publicUrl?.replace(/\/$/, "");
  const open = url
    ? `${url}/event/<id> opens it in the timeline, scrolled to and highlighting the event (for a chat message, with its conversation open).`
    : "<your-host>/event/<id> opens it in the timeline web app.";
  return `Timeline tools list events with \`#<id>\`, the stable timeline event id (events.id in run_sql). Pass it to get_context or export_conversation as event_id. ${open} ${HIDDEN_CONTACTS_NOTE}

${memoryInstructions(appStateDb, { readOnly: options.readOnly, hiddenContactIds: options.hiddenContactIds })}`;
}

/**
 * searchByLocation takes only the place, so the other query_events filters
 * (text, source, type, date) apply to what it returns.
 */
function locationSearchFilter(filters: {
  query?: string; source?: string; type?: string; date?: string; start_date?: string; end_date?: string;
}): (event: TimelineEvent) => boolean {
  const checks: ((e: TimelineEvent) => boolean)[] = [];
  const lowerQuery = filters.query?.toLowerCase();
  if (lowerQuery) {
    checks.push((e) => !!(e.title?.toLowerCase().includes(lowerQuery) || e.content?.toLowerCase().includes(lowerQuery)));
  }
  if (filters.source) {
    const sources = new Set(filters.source.split(",").map(s => s.trim()));
    checks.push((e) => sources.has(e.source));
  }
  if (filters.type) {
    const types = filters.type.split(",").map(t => t.trim());
    checks.push((e) => types.some(t => e.type.startsWith(t)));
  }
  const { date, start_date } = filters;
  if (date) checks.push((e) => !!e.timestamp?.startsWith(date));
  if (start_date) checks.push((e) => !!e.timestamp && e.timestamp >= start_date);
  const endValue = expandEndDateToEndOfDay(filters.end_date);
  if (endValue) checks.push((e) => !!e.timestamp && e.timestamp <= endValue);
  return (e) => checks.every((check) => check(e));
}

/**
 * The sources a query_events call leaves out: those it names, or for a keyword
 * search over every source, the noisy machine sources (AI-assistant sessions,
 * screen recall), with a line saying so. "" leaves nothing out.
 */
function excludedSources(
  excludeSource: string | undefined,
  keywordSearchOfAll: boolean,
): { excludeSources?: string[]; notice: string } {
  if (excludeSource !== undefined) return { excludeSources: splitSources(excludeSource), notice: "" };
  if (!keywordSearchOfAll) return { notice: "" };
  return {
    excludeSources: [...NOISY_MACHINE_SOURCES],
    notice: `Not searched: ${NOISY_MACHINE_SOURCES.join(", ")} (pass exclude_source: "" to include them).\n`,
  };
}

/** The same JSON with each leaf replaced by its type name. */
function valueTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(valueTypes);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, valueTypes(inner)]));
  }
  return value === null ? null : typeof value;
}

/** Date-bounded queries list oldest first; the rest newest first. */
function rangeOrder(...bounds: (string | undefined)[]): PageOrder {
  return bounds.some(Boolean) ? "oldest first" : "newest first";
}

/** Split a comma-separated source list param into trimmed names (undefined when absent/empty). */
function splitSources(value: string | undefined): string[] | undefined {
  const sources = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return sources && sources.length > 0 ? sources : undefined;
}

export interface RegisterToolsOptions {
  /** Optional recorder used by transports to persist MCP tool call metadata. */
  recordToolCall?: (rec: ToolCallRecord) => void;
  /** Optional app-state database for MCP session history tools. Resolved lazily when omitted. */
  appStateDb?: Database;
  /** Fallback session id for transports, such as stdio, whose SDK extra has no session id. */
  defaultSessionId?: () => string | undefined;
  /** Embedding model and index for semantic_search; unset leaves the tool returning a setup message. */
  semanticSearch?: SemanticSearch;
  /** Leave out every tool that can change anything (a read-only MCP token). */
  readOnly?: boolean;
}

export interface ToolCallRecord {
  sessionId: string | undefined;
  requestId?: RequestId;
  toolName: string;
  args: unknown;
  resultText: string | null;
  isError: boolean;
  durationMs: number;
}

/**
 * What a client shows for a tool and decides approval by. A tool that writes
 * says whether it can overwrite or delete (destructiveHint) and whether
 * repeating a call changes nothing more (idempotentHint). A tool is
 * open-world only if it sends something outside Timeline.
 */
type ToolLabels = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const reads = (title: string): ToolLabels => ({ title, readOnlyHint: true });

type ToolCallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Register all MCP tools on the given server.
 * Used by both stdio (mcp.ts) and HTTP (api/mcp-http.ts) transports.
 */
export function registerTools(
  server: McpServer,
  db: QueryExecutor,
  options: RegisterToolsOptions = {},
): void {
  const recordToolCall = options.recordToolCall;
  const getMcpHistoryDb = (): Database => options.appStateDb ?? getAppStateDb();
  const getCallerSessionId = (extra?: ToolCallExtra): string | undefined =>
    extra?.sessionId ?? options.defaultSessionId?.();
  // Every tool declares whether it can change anything. A read-only session is
  // not offered the tools that can, and the SDK refuses a call to one.
  function tool<Args extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Args,
    annotations: ToolLabels,
    cb: ToolCallback<Args>,
  ): void {
    const registered = server.tool(name, description, schema, { openWorldHint: false, ...annotations }, cb);
    if (options.readOnly && !annotations.readOnlyHint) registered.disable();
  }
  const mcpTranscriptExcerptHint = `Arguments are excerpted to ${DEFAULT_MCP_ARGS_EXCERPT_CHARS} chars and results to ${DEFAULT_MCP_RESULT_EXCERPT_CHARS} chars.`;

  /**
   * The session a search is scoped to ("current" is the caller's) and the
   * session's own facts to lead its calls; an unknown id is an error.
   */
  function sessionScope(
    requested: string | undefined,
    extra: ToolCallExtra | undefined,
    historyDb: Database,
  ): { sessionId?: string; sessionHeader: string; error?: never } | { error: CallToolResult } {
    if (requested === undefined) return { sessionHeader: "" };
    const sessionId = requested === "current" ? getCallerSessionId(extra) : requested;
    if (!sessionId) {
      return {
        error: {
          isError: true,
          content: [{ type: "text" as const, text: "Error: this MCP request has no session id, so \"current\" names no session. List sessions with sessions: true." }],
        },
      };
    }
    const session = getMcpSession(sessionId, historyDb);
    if (!session) {
      return { error: { isError: true, content: [{ type: "text" as const, text: `Error: MCP session not found: ${sessionId}` }] } };
    }
    return { sessionId, sessionHeader: `${renderMcpSessionHeader(session, getMcpSessionStats(sessionId, historyDb)).join("\n")}\n\n` };
  }

  async function instrumentToolCall(
    name: string,
    args: unknown,
    extra: ToolCallExtra | undefined,
    handler: () => CallToolResult | Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    // Read hidden contacts afresh for every call: a stdio server is a separate
    // process the web app's invalidation never reaches.
    invalidateHiddenClauseCaches();
    // get_updates sizes its reply to its own max_tokens.
    const run = name === "get_updates" ? handler : async () => cutToBudget(await handler());
    if (!recordToolCall) return run();

    const start = performance.now();
    let text: string | null = null;
    let isError = false;
    try {
      const result = await run();
      text = result.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n");
      isError = result.isError === true || text.startsWith("Error:");
      return result;
    } catch (error) {
      isError = true;
      text = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      try {
        recordToolCall({
          sessionId: getCallerSessionId(extra),
          requestId: extra?.requestId,
          toolName: name,
          args,
          resultText: text,
          isError,
          durationMs: Math.round(performance.now() - start),
        });
      } catch (error) {
        console.error("[MCP] recordToolCall failed:", error);
      }
    }
  }

  // ========================================================================
  // 1. search_mcp_tool_calls — cross-session MCP call search
  // ========================================================================
  tool(
    "search_mcp_tool_calls",
    `Search recorded MCP tool calls across sessions, newest first, as markdown. Filters compose: session_id ("current" for this session), tool_name, errors_only, and since (an ISO timestamp with timezone). With sessions: true, lists recorded sessions instead (transport, client, call and error counts, last activity). Paged with limit and offset. ${mcpTranscriptExcerptHint}`,
    {
      sessions: z.boolean().optional().default(false).describe("List sessions instead of calls; other filters are ignored"),
      session_id: z.string().min(1).optional().describe('Scope to one session; "current" is this one'),
      tool_name: z.string().min(1).optional().describe("Optional exact tool name filter"),
      errors_only: z.boolean().optional().default(false).describe("Only return tool calls recorded as errors"),
      since: z.string().optional().describe("Only return calls created at or after this ISO timestamp with timezone"),
      limit: z.number().int().min(1).max(200).optional().default(100).describe("Max calls or sessions to return (default 100, max 200)"),
      offset: z.number().int().min(0).optional().default(0).describe("Number to skip for paging"),
    },
    reads("Search MCP tool calls"),
    async (params, extra) => instrumentToolCall("search_mcp_tool_calls", params, extra, async () => {
      const errorsOnly = params.errors_only ?? false;
      const limit = params.limit ?? 100;
      const offset = params.offset ?? 0;
      const historyDb = getMcpHistoryDb();
      if (params.sessions) {
        return {
          content: [{ type: "text" as const, text: renderMcpSessionListMarkdown(listMcpSessions({ limit, offset }, historyDb)) }],
        };
      }
      const scope = sessionScope(params.session_id, extra, historyDb);
      if (scope.error) return scope.error;
      const { sessionId, sessionHeader } = scope;
      let since: string | undefined;
      if (params.since !== undefined) {
        const normalizedSince = normalizeMcpToolCallSince(params.since, historyDb);
        if (!normalizedSince) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Error: ${MCP_TOOL_CALL_SINCE_ERROR}` }],
          };
        }
        since = normalizedSince;
      }

      const calls = searchMcpToolCalls({
        sessionId,
        toolName: params.tool_name,
        isError: errorsOnly,
        since,
        limit,
        offset,
      }, historyDb);
      const filter = { sessionId, toolName: params.tool_name, errorsOnly, since: params.since, limit, offset };
      const text = await fitReply(calls.length, (n) => {
        const page = sessionHeader + renderMcpCallSearchMarkdown(calls.slice(0, n), filter);
        return n < calls.length
          ? `${page}\n\nShowing ${n} of ${calls.length} calls; the rest did not fit in one reply. Next page: the same arguments with offset: ${offset + n}.`
          : page;
      });
      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // ========================================================================
  // 2. query_events — unified search/browse/filter
  // ========================================================================
  tool(
    "query_events",
    `Search and filter timeline events. All parameters are optional and composable.

Returns formatted event list, newest first by default (oldest first when date range is specified).

Examples:
- Text search: query_events(query: "hiking")
- Date browsing: query_events(date: "2025-06-15")
- Recent by source: query_events(source: "spotify")
- Contact events: query_events(contact: "Alice", source: "discord")
- Location: query_events(location: "London")
- Coordinates: query_events(latitude: 51.5, longitude: -0.12)
- Combined: query_events(query: "project", contact: "Bob", start_date: "2025-01-01")`,
    {
      query: z.string().optional().describe('Text search across titles, content, and location names. Words are ANDed with punctuation ignored (e.g. "board-games" also matches text mentioning board and games separately) and match other English endings of the same word (run matches runs and running); end a word with * to match words starting with it (poi* matches point); wrap words in double quotes to match them exactly as written; prefix a word or quote with - to exclude events containing it (-club, -"running late")'),
      source: z.string().optional().describe("Filter by source (spotify, discord, reddit, facebook, etc.)"),
      type: z.string().optional().describe("Filter by event type (listen:track, message:dm, post, etc.)"),
      contact: z.string().optional().describe("Contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…, or a bare Discord snowflake) — returns events involving this person across all platforms"),
      date: z.string().optional().describe("Single date (YYYY-MM-DD)"),
      start_date: z.string().optional().describe("Start of date range (ISO 8601)"),
      end_date: z.string().optional().describe("End of date range (ISO 8601)"),
      location: z.string().optional().describe("Location name to search for"),
      latitude: z.number().optional().describe("Latitude for coordinate search"),
      longitude: z.number().optional().describe("Longitude for coordinate search"),
      radius_km: z.number().optional().describe("Search radius in km when latitude/longitude are given (default 1; ignored otherwise)"),
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional().default(50).describe(`Max results (default 50, max ${MAX_EVENT_LIMIT})`),
      exclude_source: z.string().optional().describe('Leave out these sources (comma-separated). A keyword search over all sources leaves out AI-assistant sessions and screen recall unless given; "" keeps them'),
      cursor: cursorParam,
      full_content: z.boolean().optional().default(false).describe("Return full content instead of truncated previews"),
      group_by_conversation: groupParam,
    },
    reads("Search events"),
    async (params, extra) => instrumentToolCall("query_events", params, extra, async () => {
      const { query, source, contact, date, location, latitude, longitude, radius_km, cursor, full_content } = params;
      const limit = params.limit ?? 50;
      const cursorError = invalidCursor(cursor);
      if (cursorError) return cursorError;
      const inputError = filterError(
        unknownSource(source),
        unknownSource(params.exclude_source, "exclude_source"),
        unknownType(params.type, source),
        badDate(date, "date", "day"),
        badDate(params.start_date, "start_date", "time"),
        badDate(params.end_date, "end_date", "time"),
      );
      if (inputError) return inputError;
      const type = typeFilter(params.type);
      const start_date = utcBound(params.start_date);
      const end_date = utcBound(params.end_date);
      const applied = Object.entries({
        query, source, type: params.type, contact, date, start_date: params.start_date, end_date: params.end_date,
        location, latitude, longitude, exclude_source: params.exclude_source,
      })
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => `${name}: ${JSON.stringify(value)}`);
      const none = applied.length > 0 ? `No events match ${applied.join(", ")}.` : "No events found.";
      // One more than asked for tells whether more exist without counting them all.
      const fetchLimit = limit + 1;
      const order: PageOrder = rangeOrder(date, start_date, end_date);
      const { excludeSources, notice } = excludedSources(params.exclude_source, Boolean(query && !source && !contact));
      const respond = (fetched: TimelineEvent[], pageOrder: PageOrder, pageOptions: PageOptions = {}, prefix = "") =>
        eventReply(db, fetched, limit, pageOrder, pageOptions, full_content, prefix + notice, none);

      // `date` narrows to that single day; like getEvents, it wins over start/end.
      // searchTimeline/searchByContact expand a bare YYYY-MM-DD endDate to end of day.
      const rangeStart = date ?? start_date;
      const rangeEnd = date ?? end_date;

      if (params.group_by_conversation) {
        return groupedQueryEvents(db, { ...params, limit, startDate: rangeStart, endDate: rangeEnd, excludeSources, notice, none });
      }

      // Strategy 1: Contact-based search
      if (contact) {
        return contactQueryEvents(db, contact, {
          query, source, type, location, cursor, limit, order, excludeSources,
          startDate: rangeStart, endDate: rangeEnd,
        }, respond);
      }

      // Strategy 2: Location-based search (name or coordinates)
      if (location || (latitude !== undefined && longitude !== undefined)) {
        const fetched = await searchByLocation(db, {
          locationName: location,
          latitude,
          longitude,
          radiusKm: radius_km,
          limit: fetchLimit,
          excludeSources,
          excludeHidden: true,
        });
        if (cursor) {
          return { isError: true, content: [{ type: "text" as const, text: "Error: a location search has no next page; raise limit instead." }] };
        }
        const keep = locationSearchFilter({ query, source, type, date, start_date, end_date });
        // searchByLocation has no cursor.
        return respond(fetched, location ? "newest first" : "oldest first", { pageable: false, filter: keep });
      }

      // Strategy 3: Text search (FTS)
      if (query) {
        const fetched = await searchTimeline(db, {
          query,
          source,
          type,
          startDate: rangeStart,
          endDate: rangeEnd,
          excludeSources,
          cursor,
          limit: fetchLimit,
        });
        return respond(fetched, order, { untimedCursor: true });
      }

      // Strategy 4: Date-based browsing
      if (date || start_date || end_date) {
        const fetched = await getEvents(db, {
          date,
          startDate: start_date,
          endDate: end_date,
          source,
          type,
          excludeSources,
          cursor,
          limit: fetchLimit,
        });
        return respond(fetched, order);
      }

      // Strategy 5: Fallback — recent events (filtered by source/type)
      const fetched = await getRecentEvents(db, { source, type, excludeSources, cursor, limit: fetchLimit });
      return respond(fetched, "newest first");
    })
  );

  // ========================================================================
  // 3. export_conversation — full untruncated conversation transcript
  // ========================================================================
  tool(
    "export_conversation",
    "Export a full conversation transcript in markdown. Unlike query_events, this returns untruncated message content in chronological order. Pass either a conversation_id or an event_id from the #<id> in query_events output.",
    {
      conversation_id: z.string().min(1).optional().describe("Conversation id to export. Provide exactly one of conversation_id or event_id."),
      event_id: z.number().int().positive().optional().describe("Timeline event id from query_events output. Provide exactly one of conversation_id or event_id; without date bounds, centers the limited window on this event."),
      limit: z.number().int().min(1).max(2000).optional().default(MCP_EXPORT_LIMIT).describe("Maximum events to render (default 500, max 2000). conversation_id alone returns the newest events; event_id returns a window around that event."),
      start_date: z.string().optional().describe("Inclusive ISO 8601 lower timestamp bound. Any date bound overrides event_id centering."),
      end_date: z.string().optional().describe("Inclusive ISO 8601 upper timestamp bound. Any date bound overrides event_id centering."),
      cursor: cursorParam,
    },
    reads("Export a conversation"),
    async (params, extra) => instrumentToolCall("export_conversation", params, extra, async () => {
      const { conversation_id, event_id, cursor } = params;
      const limit = params.limit ?? MCP_EXPORT_LIMIT;
      // A cursor pages back from the newest; one with no timestamp names no place to page from.
      const before = cursor === undefined ? undefined : parseCursor(cursor);
      if (before === null) return badCursor(cursor ?? "");
      const dateError = filterError(badDate(params.start_date, "start_date", "time"), badDate(params.end_date, "end_date", "time"));
      if (dateError) return dateError;
      const start_date = utcBound(params.start_date);
      const end_date = utcBound(params.end_date);

      if ((conversation_id === undefined) === (event_id === undefined)) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Times in UTC.\nTranscript tokens: 0.\nError: Provide exactly one of conversation_id or event_id.",
          }],
        };
      }

      let conversationId = conversation_id;
      let conversationSource: string | undefined;
      if (event_id !== undefined) {
        const event = await db.get<{ conversation_id: string | null; source: string }>(
          "SELECT conversation_id, source FROM events WHERE id = ?",
          event_id,
        );
        if (!event || (await withoutHiddenContactEvents(db, [{ id: event_id }])).length === 0) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Times in UTC.\nTranscript tokens: 0.\nError: No event found with id ${event_id}.` }],
          };
        }
        if (!event.conversation_id) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: `Times in UTC.\nTranscript tokens: 0.\nError: Event ${event_id} has no conversation_id, so its conversation cannot be exported.`,
            }],
          };
        }
        conversationId = event.conversation_id;
        // Two sources can share a conversation id (phone and google-messages do).
        conversationSource = event.source;
      }

      if (!conversationId) {
        throw new Error("Conversation id was not resolved");
      }

      const centered = event_id !== undefined && start_date === undefined && end_date === undefined && before === undefined;
      const renderOptions = { compactAuthors: true, noSummaries: false, fullTimestamps: false, hiddenContactName: HIDDEN_CONTACT_NAME };
      const result = await exportConversation(db, {
        conversationId,
        startDate: start_date,
        endDate: expandEndDateToEndOfDay(end_date),
        before,
      }, {
        limit,
        source: conversationSource,
        excludeHidden: true,
        mostRecent: true,
        includeTotal: true,
        aroundEventId: centered ? event_id : undefined,
        ...renderOptions,
      });
      const { events } = result;
      const total = result.totalEventCount ?? events.length;
      const anchor = events.findIndex((e) => e.id === event_id);
      // The n events kept when the reply cannot hold them all: those nearest
      // the anchor event, or the newest.
      const kept = (n: number) => {
        if (!centered) return events.slice(events.length - n);
        const start = Math.min(Math.max(anchor - Math.floor((n - 1) / 2), 0), events.length - n);
        return events.slice(start, start + n);
      };
      // The event after a centered window, to re-center on for later events;
      // like the export, never a hidden contact's.
      const notHidden = await hasHiddenContacts(db) ? ` AND id NOT IN (${hiddenEventIdsSubquery()})` : "";
      const after = async (last: TimelineEvent | undefined) => last?.timestamp && centered
        ? (await db.get<{ id: number }>(
          `SELECT id FROM events WHERE conversation_id = ? AND source = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))${notHidden}
           ORDER BY timestamp, id LIMIT 1`,
          conversationId, last.source, last.timestamp, last.timestamp, last.id,
        ))?.id
        : undefined;
      const text = await fitReply(events.length, async (n) => {
        const shown = kept(n);
        const transcript = n === events.length ? result.text : await renderExportText(db, shown, renderOptions);
        const earlier = shown[0] && createCursor(shown[0]);
        const later = total > n ? await after(shown[shown.length - 1]) : undefined;
        const next = [
          earlier && `earlier events: the same arguments with cursor: "${earlier}"`,
          later && `later ones: event_id: ${later}`,
        ].filter(Boolean).join("; ");
        const limitNote = total <= n
          ? undefined
          : `Showing ${centered ? `${n} of ${total} events around event #${event_id}` : `the newest ${n} of ${total} events`}.${next ? ` Next page: ${next}.` : ""}`;
        const metadata = [
          `Conversation: ${result.conversationId}`,
          `Events: ${n}`,
          ...(limitNote ? [limitNote] : []),
          `Transcript tokens: ${(n === events.length ? result.tokenCount : transcript && countTokens(transcript)) ?? 0}.`,
        ];
        const reply = withTranscriptMetadata(metadata, transcript);
        return limitNote && n < events.length ? `${reply}\n\n${limitNote}` : reply;
      });

      return { content: [{ type: "text" as const, text }] };
    }),
  );

  // ========================================================================
  // 4. get_context — events around a specific time
  // ========================================================================
  tool(
    "get_context",
    `Get events surrounding a specific event or timestamp to understand context.`,
    {
      event_id: z.number().optional().describe("Event ID to center the context around"),
      timestamp: z.string().optional().describe("Timestamp to center around (ISO 8601)"),
      hours_window: z.number().optional().default(2).describe("Hours before and after to include (default 2)"),
      source: z.string().optional().describe("Only include these sources (comma-separated, e.g. \"discord,spotify\")"),
      exclude_source: z.string().optional().describe("Drop these sources from the window (comma-separated) — e.g. \"claude-code,conductor,t3code,codex\" to hide AI agent-session noise"),
      limit: z.number().int().min(1).max(MAX_EVENT_LIMIT).optional().default(50).describe(`Max results (default 50, max ${MAX_EVENT_LIMIT})`),
      same_conversation: z.boolean().optional().describe("Only events in event_id's own conversation (chat, channel or DM)"),
      cursor: cursorParam,
      full_content: z.boolean().optional().default(false).describe("Return full content instead of truncated previews"),
    },
    reads("Events around a moment"),
    async (params, extra) => instrumentToolCall("get_context", params, extra, async () => {
      const { event_id, timestamp, hours_window, source, exclude_source, cursor, full_content } = params;
      const limit = params.limit ?? 50;
      const cursorError = invalidCursor(cursor);
      if (cursorError) return cursorError;
      const inputError = filterError(
        unknownSource(source),
        unknownSource(exclude_source, "exclude_source"),
        badDate(timestamp, "timestamp", "time"),
      );
      if (inputError) return inputError;
      let conversation: { source: string; sourceAccount: string; conversationId: string } | undefined;
      if (params.same_conversation) {
        const anchor = event_id === undefined
          ? null
          : await db.get<{ source: string; source_account: string | null; conversation_id: string | null }>(
            "SELECT source, source_account, conversation_id FROM events WHERE id = ?",
            event_id,
          );
        if (!anchor?.conversation_id || !anchor.source_account || event_id === undefined
          || (await withoutHiddenContactEvents(db, [{ id: event_id }])).length === 0) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Error: same_conversation needs an event_id of an event in a conversation." }],
          };
        }
        conversation = { source: anchor.source, sourceAccount: anchor.source_account, conversationId: anchor.conversation_id };
      }
      const fetched = await getEventContext(db, {
        eventId: event_id,
        timestamp,
        hoursWindow: hours_window,
        sources: splitSources(source),
        excludeSources: splitSources(exclude_source),
        conversation,
        excludeHidden: true,
        cursor,
        limit: limit + 1,
      });
      return eventReply(db, fetched, limit, "oldest first", {}, full_content, "");
    })
  );

  // ========================================================================
  // 5. get_schema — DB schema + source catalog, or raw_data JSON paths
  // ========================================================================
  tool(
    "get_schema",
    `How to query the database with run_sql: tables, columns, conventions, worked queries and the sources. With source, that source's types and the raw_data JSON paths for json_extract().`,
    {
      source: z.string().optional().describe("Source to inspect raw_data JSON structure (spotify, discord, monzo, etc.)"),
      type: z.string().optional().describe("Optional type filter when inspecting raw_data"),
    },
    reads("SQL guide"),
    async (params, extra) => instrumentToolCall("get_schema", params, extra, async () => {
      const source = params.source?.trim();
      const inputError = filterError(
        source?.includes(",") ? "get_schema takes one source." : unknownSource(source),
        unknownType(params.type, source),
      );
      if (inputError) return inputError;
      const type = typeFilter(params.type);
      // Source specified → raw_data JSON schema
      if (source) {
        const schema = await getRawDataSchema(db, { source, type, excludeHidden: true });

        if (schema.sampleCount === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No events found for source="${source}"${type ? ` type="${type}"` : ""}`,
            }],
          };
        }

        const anyHidden = await hasHiddenContacts(db);
        const types = await db.query<{ type: string; n: number }>(
          `SELECT type, count(*) AS n FROM events WHERE source = ?${anyHidden ? ` AND id NOT IN (${hiddenEventIdsSubquery()})` : ""} GROUP BY type ORDER BY n DESC`,
          source,
        );
        const lines = [
          `Source: ${source}${type ? ` (type: ${type})` : ""}`,
          `Types: ${types.map((t) => `${t.type} ${t.n}`).join(", ")}`,
          `Samples analyzed: ${schema.sampleCount}`,
          "",
          "JSON paths (use with json_extract):",
          ...schema.paths.map(p => `  ${p}`),
          "",
          // A visible event's raw_data can embed a hidden contact's message
          // (a Discord reply's referenced_message), so with any hidden, the
          // sample shows each value's type, not the value.
          anyHidden ? "Sample (value types):" : "Sample (truncated):",
          JSON.stringify(anyHidden ? valueTypes(schema.sample) : schema.sample, null, 2),
        ];

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }

      // No params → what a model needs to write SQL, and the sources.
      // Counts, no content: hidden contacts' events count, which spares a NOT IN over every event.
      const sources = await listSources(db, { includeHiddenContacts: true });
      // One index seek per source (idx_events_source_timestamp), not a scan.
      const latest = new Map<string, string | null>();
      for (const source of new Set(sources.map((s) => s.source))) {
        const row = await db.get<{ latest: string | null }>("SELECT max(timestamp) AS latest FROM events WHERE source = ?", source);
        latest.set(source, row?.latest ?? null);
      }
      return {
        content: [{ type: "text" as const, text: renderSchemaOverview(sources, latest) }],
      };
    })
  );

  // ========================================================================
  // 6. run_sql — raw SELECT queries
  // ========================================================================
  tool(
    "run_sql",
    `Execute SELECT queries for complex analysis beyond what specialized tools provide.
Returns TSV format, max 150 rows. Call get_schema for full table/column details.

Tips:
- Always specify columns explicitly (never SELECT *)
- Avoid raw_data column (very large)
- Use events_fts for full-text search
- Use json_extract() for raw_data fields
- Use export_conversation rather than run_sql to read a conversation transcript
- Select \`id\` from \`events\` to get the timeline event id (same value shown as \`#<id>\` in query_events output)`,
    {
      sql: z.string().describe("SQL SELECT query to execute"),
    },
    reads("Run SQL"),
    async (params, extra) => instrumentToolCall("run_sql", params, extra, async () => {
      const { sql } = params;
      const result = await runReadOnlySql(db, sql, 150);

      if (result.timeout) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: formatRunSqlTimeout(result.timeout.timeoutMs) }],
        };
      }

      if (result.error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        };
      }

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "(no results)" }],
        };
      }

      const text = await fitReply(result.rows.length, (n) => {
        const tsv = toTSV(result.rows.slice(0, n));
        if (n < result.rows.length) {
          return `${tsv}\nShowing ${n} of ${result.count} rows; the rest did not fit in one reply. Select fewer or shorter columns (substr()), or page with LIMIT and OFFSET.`;
        }
        return (result.count > 150 ? `Showing 150 of ${result.count} rows\n` : "") + tsv;
      });
      return { content: [{ type: "text" as const, text }] };
    })
  );

  // ========================================================================
  // 7. list_contacts
  // ========================================================================
  tool(
    "list_contacts",
    "List all contacts in the timeline. Contacts link people across platforms (e.g., same person on Discord, Skype, Facebook).",
    {
      search: z.string().optional().describe("Filter by name; also accepts a platform identifier (e.g. discord:123…, phone:+44…, or a bare Discord snowflake) to look up the linked contact"),
    },
    reads("List contacts"),
    async (params, extra) => instrumentToolCall("list_contacts", params, extra, async () => {
      const { search } = params;
      let contacts = await listContacts(db, { search });

      // Identity-aware fallback: if the name search came up empty, the search
      // term might be a platform identifier (e.g. a Discord snowflake the
      // caller pulled out of message content). Probe the identities table.
      if (contacts.length === 0 && search) {
        const identity = await resolveContactByIdentity(db, search);
        if (identity) {
          const ids = "ambiguous" in identity
            ? identity.ambiguous.map((r) => r.contact_id)
            : [identity.contactId];
          contacts = await listContacts(db, { ids });
        }
      }

      if (contacts.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No contacts found." }],
        };
      }

      const lines = contacts.map((c) => {
        const notesTag = c.notes ? ` - ${c.notes}` : "";
        const detailsTag = c.date_of_birth ? ` [DOB: ${formatBirthdayForDisplay(c.date_of_birth)}]` : "";
        const platformLabel = c.platformCount === 1 ? "platform" : "platforms";
        const activeIdentityLabel = c.activeIdentityCount === 1 ? "active identity" : "active identities";
        return `${c.id}. ${c.display_name}${detailsTag} (${c.platformCount} ${platformLabel} · ${c.activeIdentityCount} ${activeIdentityLabel} · ${c.eventCount} events)${notesTag}`;
      });

      const text = await fitReply(lines.length, (n) => n < lines.length
        ? `${lines.slice(0, n).join("\n")}\nShowing ${n} of ${lines.length} contacts; the rest did not fit in one reply. Narrow with search.`
        : lines.join("\n"));
      return { content: [{ type: "text" as const, text }] };
    })
  );

  // ========================================================================
  // 8. get_contact_info
  // ========================================================================
  tool(
    "get_contact_info",
    "Get detailed profile information for a contact including structured fields (birthday, location, email, phone), notes, identities, saved facts and linked memory notes. Accepts a contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…, or a bare snowflake from a Discord <@id> mention).",
    {
      contact: z.string().describe("Contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…, or a bare Discord snowflake)"),
    },
    reads("Contact details"),
    async (params, extra) => instrumentToolCall("get_contact_info", params, extra, async () => {
      const { contact } = params;
      const resolved = await resolveContact(db, contact);
      if (resolved.error) {
        return { content: resolved.error, isError: true };
      }

      const contactObj = resolved.contact;
      const identities = await getIdentitiesForContact(db, contactObj.id);
      const memories = await getContactMemories(db, contactObj.id);

      const lines = [
        `Contact: ${contactObj.display_name} (ID: ${contactObj.id})`,
      ];

      // Profile fields
      const fields: string[] = [];
      if (contactObj.date_of_birth) fields.push(`Birthday: ${formatBirthdayForDisplay(contactObj.date_of_birth)}`);
      // Derive email/phone from identities
      const emailPlatforms = new Set(["google-calendar", "google-chat"]);
      for (const id of identities) {
        if (emailPlatforms.has(id.platform) && id.platform_id.includes("@")) {
          fields.push(`Email: ${id.platform_id}`);
          break;
        }
      }
      for (const id of identities) {
        if (id.platform === "phone") {
          fields.push(`Phone: ${id.platform_id}`);
          break;
        }
      }
      if (fields.length > 0) {
        lines.push(fields.join(" | "));
      }

      if (contactObj.notes) {
        lines.push(`Notes: ${contactObj.notes}`);
      }

      // Identities
      if (identities.length > 0) {
        lines.push("");
        lines.push(`Identities (${identities.length}):`);
        for (const id of identities) {
          const name = id.display_name || id.username || id.platform_id;
          lines.push(`  ${id.platform}: ${name} (${id.event_count} events)`);
        }
      }

      // Memories
      if (memories.length > 0) {
        lines.push("");
        lines.push(`Memories (${memories.length}):`);
        for (const m of memories) {
          lines.push(`  - ${m.content} (${m.created_at})`);
        }
      }

      const notes = listContactMemoryNotes(getMcpHistoryDb(), contactObj.id);
      if (notes.length > 0) {
        lines.push("");
        lines.push(`Memory notes (${notes.length}, read with get_memory_note):`);
        for (const n of notes) {
          lines.push(`  - ${n.name}${n.project ? ` (project ${n.project})` : ""}: ${n.title} — ${n.summary}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    })
  );

  // ========================================================================
  // 9. semantic_search — vector similarity search over indexed events
  //     Both server entries configure sqlite-vec before opening any DB, so this
  //     can run on either transport; it still gates on options.embeddings at
  //     call time and reports a clear error if sqlite-vec can't load.
  // ========================================================================
  tool(
    "semantic_search",
    `Search timeline events by *meaning* using vector embeddings, complementing query_events (which does keyword/FTS matching). Reach for this on conceptual queries where the exact words may not appear in the events — e.g. "times I felt burned out", "planning a trip abroad", "conversations about moving house". Results are ranked by similarity, closest first.

Requires embeddings to be configured and an index to be built (see docs/user/embeddings.md). When embeddings aren't configured this returns a short setup message instead of results. Indexed conversation windows follow the events, each with an #id for export_conversation.`,
    {
      query: z.string().trim().min(1).describe("Natural-language query, matched by meaning against indexed event content"),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max events to return (1-50, default 10)"),
      full_content: z.boolean().optional().default(false).describe("Return full content instead of truncated previews"),
      group_by_conversation: groupParam,
    },
    // The query goes to the configured embeddings endpoint, which may be remote.
    { ...reads("Search by meaning"), openWorldHint: true },
    async (params, extra) => instrumentToolCall("semantic_search", params, extra, async () => {
      const { query, limit, full_content } = params;
      if (!options.semanticSearch) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `${notConfiguredMessage()} Then build an index with \`bun run embeddings index\`.`,
          }],
        };
      }

      const candidateLimit = Math.min(limit * 10, 250);
      let hits: Awaited<ReturnType<typeof searchEmbeddingsWithWindows>>["hits"];
      let windows: Awaited<ReturnType<typeof searchEmbeddingsWithWindows>>["windows"];
      let windowsError: string | undefined;
      try {
        ({ hits, windows, windowsError } = await searchEmbeddingsWithWindows(options.semanticSearch, query, candidateLimit, limit));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Semantic search failed: ${message}` }],
        };
      }

      windows = await withoutHiddenWindows(db, windows);

      // Present only once a conversation-window pilot has indexed some windows.
      const windowSection = windows.length > 0
        ? `\n\n${windows.length} conversation window(s) most similar, closest first; each is a stretch of one conversation, and its #id opens it with export_conversation:\n${windows.map(formatWindowHit).join("\n")}`
        : windowsError ? `\n\nConversation windows could not be searched: ${windowsError}` : "";

      // All hits hidden reads as no hits.
      const noHits = `No events found near "${query}". The index may be empty for this model — run \`bun run embeddings index\` first.${windowSection}`;
      if (hits.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: noHits,
          }],
        };
      }

      // hits come back closest-first; a document can map to several events and
      // KNN bounds documents, not events, so dedupe to unique events in that
      // order and cap to the requested count after dropping any whose row no
      // longer exists in timeline.db.
      const hydrated = await hydrateEventsById(db, hits.map((hit) => hit.event_id));
      const missingCount = hydrated.missingCount;
      const events = (await withoutHiddenContactEvents(db, hydrated.events)).slice(0, limit);

      if (events.length === 0 && hydrated.events.length > 0) {
        return { content: [{ type: "text" as const, text: noHits }] };
      }
      if (events.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `Semantic search found indexed vector hits for "${query}", but none of their events still exist in timeline.db. The embeddings index may be stale — run \`bun run embeddings index\` after refreshing the database.${windowSection}`,
          }],
        };
      }

      const staleNote = missingCount > 0
        ? ` Skipped ${missingCount} indexed hit(s) whose events no longer exist in timeline.db.`
        : "";
      const header = `${events.length} event(s) most similar to "${query}", closest first (nearest matches by meaning, not exact).${staleNote}\n\n`;

      if (params.group_by_conversation) {
        const groups = groupByConversation(events);
        return {
          content: [{
            type: "text" as const,
            text: `${header}Times in UTC. ${groups.length} group${groups.length === 1 ? "" : "s"}, closest first. ${READ_GROUP}\n${formatGroups(groups, "closest")}${windowSection}`,
          }],
        };
      }

      const text = await fitReply(events.length, async (n) => {
        const cut = n < events.length
          ? `\nShowing ${n} of ${events.length} events; the rest did not fit in one reply. Leave out full_content to see them all.`
          : "";
        return header + (await formatEvents(db, events.slice(0, n), full_content)) + windowSection + cut;
      });
      return { content: [{ type: "text" as const, text }] };
    })
  );

  // ========================================================================
  // 10-13. Shared memory: notes any connected agent can read and write
  // ========================================================================
  const memoryError = (error: unknown): CallToolResult => ({
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
  });
  /** A note linked to a hidden contact reads here as no note at all. */
  const isHiddenLinkedNote = async (project: string, name: string): Promise<boolean> => {
    const note = getMemoryNote(getMcpHistoryDb(), project, name);
    return note?.contact_id != null && (await hiddenContactIds(db)).has(note.contact_id);
  };
  const noNote = (project: string, name: string) =>
    memoryError(`No note named "${name}" in ${project ? `project ${project}` : "the account"}; list_memory lists them.`);
  const projectParam = z.string().optional().describe("Repository name; omit for account notes");
  const nameParam = z.string().max(MEMORY_LIMITS.name).describe("Lowercase slug, unique in its scope");

  tool(
    "list_memory",
    "Index of the user's shared memory: each note's name, title, summary and update date, by kind. With project, that project's notes come first, then the account's, which apply everywhere.",
    { project: projectParam },
    reads("List memory"),
    async (params, extra) => instrumentToolCall("list_memory", params, extra, async () => {
      try {
        const project = projectScope(params.project);
        const appDb = getMcpHistoryDb();
        const hidden = await hiddenContactIds(db);
        const notes = listMemoryNotes(appDb, project).filter((note) => note.contact_id === null || !hidden.has(note.contact_id));
        const index = renderMemoryIndex(notes, project, projectUsesAccountMemory(appDb, project));
        return { content: [{ type: "text" as const, text: index }] };
      } catch (error) {
        return memoryError(error);
      }
    }),
  );

  tool(
    "get_memory_note",
    "Read a memory note in full. [[name]] in its details links to another note, in the same project or the account; it may not exist.",
    { name: nameParam, project: projectParam },
    reads("Read a memory note"),
    async (params, extra) => instrumentToolCall("get_memory_note", params, extra, async () => {
      try {
        const project = projectScope(params.project);
        const note = getMemoryNote(getMcpHistoryDb(), project, params.name);
        if (!note || (note.contact_id !== null && (await hiddenContactIds(db)).has(note.contact_id))) {
          return noNote(project, params.name);
        }
        return { content: [{ type: "text" as const, text: renderMemoryNote(note) }] };
      } catch (error) {
        return memoryError(error);
      }
    }),
  );

  tool(
    "save_memory_note",
    "Create a memory note, or update the one with this name in this scope, replacing only the fields given. Save durable facts, preferences and corrections; never secrets, credentials or task state. Link other notes as [[name]], even ones not written yet.",
    {
      name: nameParam,
      project: projectParam,
      kind: z.enum(MEMORY_KINDS).optional().describe('you = the user\'s preferences and profile; project = the project itself, "overview" listed first'),
      title: z.string().optional(),
      summary: z.string().optional().describe("One line, shown in the index"),
      details: z.string().optional().describe("Markdown, usually bullets"),
      contact: z.string().optional().describe("The contact a note about a person is linked to, as get_contact_info takes, which then lists the note; \"\" unlinks"),
    },
    { title: "Save a memory note", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (params, extra) => instrumentToolCall("save_memory_note", params, extra, async () => {
      try {
        let contactId: number | null | undefined;
        if (params.contact === "") {
          contactId = null;
        } else if (params.contact !== undefined) {
          const resolved = await resolveContact(db, params.contact);
          if (resolved.error) return { content: resolved.error, isError: true };
          contactId = resolved.contact.id;
        }
        const project = projectScope(params.project);
        // Checked as a new note would be, so a call that could not create one
        // fails the same way; one that could is refused, since the name is taken.
        if (await isHiddenLinkedNote(project, params.name)) {
          checkNewMemoryNote(getMcpHistoryDb(), { ...params, project });
          return memoryError(`Note "${params.name}" can't be saved: the name is taken.`);
        }
        const { note, created } = saveMemoryNote(getMcpHistoryDb(), {
          project,
          name: params.name,
          kind: params.kind,
          title: params.title,
          summary: params.summary,
          details: params.details,
          contactId,
        });
        const scope = project ? `project ${project}` : "account";
        return {
          content: [{
            type: "text" as const,
            text: `${created ? "Created" : "Updated"} memory: ${note.title} (${note.name}, ${scope})`,
          }],
        };
      } catch (error) {
        return memoryError(error);
      }
    }),
  );

  tool(
    "delete_memory_note",
    "Delete a memory note. Its last version is kept for a time, so the user can restore it.",
    { name: nameParam, project: projectParam },
    { title: "Delete a memory note", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (params, extra) => instrumentToolCall("delete_memory_note", params, extra, async () => {
      try {
        const project = projectScope(params.project);
        if (await isHiddenLinkedNote(project, params.name)) return noNote(project, params.name);
        const note = deleteMemoryNote(getMcpHistoryDb(), project, params.name);
        if (!note) return noNote(project, params.name);
        const scope = project ? `project ${project}` : "account";
        return { content: [{ type: "text" as const, text: `Deleted memory: ${note.title} (${note.name}, ${scope})` }] };
      } catch (error) {
        return memoryError(error);
      }
    }),
  );

  tool(
    "get_updates",
    GET_UPDATES_DESCRIPTION,
    GET_UPDATES_SCHEMA,
    reads("What's new"),
    async (params, extra) => instrumentToolCall("get_updates", params, extra, () =>
      filterError(
        unknownSource(params.sources, "sources"),
        // A date such as 2026-11-31 would otherwise roll over to December.
        /^\d{4}-\d{2}-\d{2}/.test(params.since.trim()) ? badDate(params.since.trim(), "since", "time") : null,
      ) ?? runGetUpdates(db, params)),
  );
}
