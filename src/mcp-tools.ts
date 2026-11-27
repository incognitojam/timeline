/**
 * MCP Tools Registration
 *
 * Shared tool definitions for both stdio and HTTP MCP transports.
 * 18 tools: list_mcp_sessions, get_mcp_session, search_mcp_tool_calls,
 *           query_events, get_context, get_summary, get_schema, run_sql,
 *           list_contacts, get_contact_info, remember_contact_fact,
 *           semantic_search, export_conversation, list_memory,
 *           get_memory_note, save_memory_note, delete_memory_note,
 *           get_updates
 */

import type { Database } from "bun:sqlite";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, RequestId, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAppStateDb } from "./db/app-state";
import {
  deleteMemoryNote,
  getMemoryNote,
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
  createContactMemory,
  createCursor,
  getAliasesForContact,
  getContact,
  getContactMemories,
  getEventContext,
  getEvents,
  getIdentitiesForContact,
  getRawDataSchema,
  getRecentEvents,
  getStats,
  getSummary,
  hydrateEventsById,
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
import { exportConversation } from "./export/export";
import {
  getAttachmentDescription,
  getMessageMarkers,
} from "./lib/format";
import {
  DEFAULT_MCP_ARGS_EXCERPT_CHARS,
  DEFAULT_MCP_RESULT_EXCERPT_CHARS,
  renderMcpCallSearchMarkdown,
  renderMcpSessionListMarkdown,
  renderMcpSessionMarkdown,
} from "./mcp/render";
import {
  getMcpSession,
  getMcpSessionStats,
  listMcpSessions,
  listMcpToolCalls,
  MCP_TOOL_CALL_SINCE_ERROR,
  normalizeMcpToolCallSince,
  searchMcpToolCalls,
} from "./mcp/recording";
import { memoryInstructions, renderMemoryIndex, renderMemoryNote } from "./mcp/memory";
import { renderSchemaOverview } from "./mcp/schema";
import { GET_UPDATES_DESCRIPTION, GET_UPDATES_SCHEMA, runGetUpdates } from "./mcp/updates";
import { getDiscordComponentsText } from "./platforms/discord/shared/components";
import { isConversationEventType } from "./shared/grouping";
import { discordMentionsToPlainText, extractUserMentionIds } from "./platforms/discord/shared/mentions";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MCP_EXPORT_LIMIT = 500;

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
    : `More ${options.filter ? "may match" : "exist"}: narrow the filters or raise limit.`;
  return { events, header: `Showing ${shown}, ${order}. ${next}\n` };
}

const cursorParam = z.string().optional().describe('From a "Next page" line');

function invalidCursor(cursor: string | undefined): CallToolResult | null {
  return cursor !== undefined && !parseCursor(cursor, { allowNullTimestamp: true })
    ? { isError: true, content: [{ type: "text" as const, text: `Error: invalid cursor "${cursor}"; pass one exactly as a "Next page" line gave it.` }] }
    : null;
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
  events: TimelineEvent[],
  fullContent = false
): Promise<string> {
  if (events.length === 0) {
    return "No events found.";
  }

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

  const discordUserResolver = (id: string): string | null =>
    resolved[`discord:${id}`]?.name ?? null;

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

/** query_events with group_by_conversation: its matches grouped in SQL, most hits first. */
async function groupedQueryEvents(
  db: QueryExecutor,
  params: {
    query?: string; source?: string; type?: string; contact?: string; location?: string; latitude?: number;
    longitude?: number; cursor?: string; startDate?: string; endDate?: string; limit: number;
  },
): Promise<CallToolResult> {
  const { query, source, type, contact, startDate, endDate, limit } = params;
  const refuse = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text" as const, text: `Error: ${text}` }] });
  if (params.location || params.latitude !== undefined || params.longitude !== undefined) {
    return refuse("group_by_conversation does not combine with location or coordinates.");
  }
  if (params.cursor) return refuse("group_by_conversation lists every group at once; it takes no cursor.");
  if (!query && !source && !type && !contact && !startDate && !endDate) {
    return refuse("group_by_conversation needs a query, contact, source, type or date filter.");
  }
  const filters = { query, source, type, startDate, endDate };
  let prefix = "";
  let groups: EventGroup[];
  if (contact) {
    const resolved = await resolveContact(db, contact);
    if (resolved.error) return { content: resolved.error, isError: true };
    prefix = `Contact: ${resolved.contact.display_name} (ID: ${resolved.contact.id})\n`;
    groups = await contactEventGroups(db, resolved.contact.id, filters, limit);
  } else {
    // MCP is an agent data-access seam and remains intentionally unfiltered.
    groups = await searchTimelineGroups(db, { ...filters, includeHiddenContacts: true }, limit);
  }
  if (groups.length === 0) return { content: [{ type: "text" as const, text: `${prefix}No events found.` }] };

  const { groups: groupCount, total_hits: totalHits } = groups[0];
  const shown = groupCount > groups.length ? ` Showing the ${groups.length} with most hits; raise limit for the rest.` : "";
  const header = `Times in UTC. ${totalHits} hit${totalHits === 1 ? "" : "s"} in ${groupCount} group${groupCount === 1 ? "" : "s"}, most hits first.${shown} ${READ_GROUP}`;
  return { content: [{ type: "text" as const, text: `${prefix}${header}\n${formatGroups(groups, "newest")}` }] };
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
    const map = await resolveIdentities(db, [input]);
    const cid = map[input]?.contactId;
    return cid != null ? { contactId: cid } : null;
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
     WHERE i.platform_id = ?
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
  if (!isNaN(contactId) && String(contactId) === contact) {
    contactObj = await getContact(db, contactId);
  }

  if (!contactObj) {
    const contacts = await listContacts(db, { includeHidden: true, search: contact });
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
      error: [{ type: "text" as const, text: `Contact "${contact}" not found.` }],
    };
  }

  return { contact: contactObj };
}

/**
 * The instructions an MCP server returns at initialise: what the event ids in
 * tool output are for, then the shared memory.
 */
export function mcpInstructions(appStateDb: Database, options: { publicUrl?: string; readOnly?: boolean } = {}): string {
  const url = options.publicUrl?.replace(/\/$/, "");
  const open = url
    ? `${url}/event/<id> opens it in the timeline, scrolled to and highlighting the event (for a chat message, with its conversation open).`
    : "<your-host>/event/<id> opens it in the timeline web app.";
  return `Timeline tools list events with \`#<id>\`, the stable timeline event id (events.id in run_sql). Pass it to get_context or export_conversation as event_id. ${open}

${memoryInstructions(appStateDb, { readOnly: options.readOnly })}`;
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

const READS = { readOnlyHint: true };
const WRITES = { readOnlyHint: false };

type ToolCallExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Register all MCP tools on the given server.
 * Used by both stdio (mcp.ts) and HTTP (api/mcp-http.ts) transports.
 */
export function registerTools(
  server: McpServer,
  db: QueryExecutor,
  writeDb?: Database,
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
    annotations: { readOnlyHint: boolean },
    cb: ToolCallback<Args>,
  ): void {
    const registered = server.tool(name, description, schema, annotations, cb);
    if (options.readOnly && !annotations.readOnlyHint) registered.disable();
  }
  const mcpTranscriptExcerptHint = `Arguments are excerpted to ${DEFAULT_MCP_ARGS_EXCERPT_CHARS} chars and results to ${DEFAULT_MCP_RESULT_EXCERPT_CHARS} chars.`;

  async function instrumentToolCall(
    name: string,
    args: unknown,
    extra: ToolCallExtra | undefined,
    handler: () => CallToolResult | Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    if (!recordToolCall) return handler();

    const start = performance.now();
    let text: string | null = null;
    let isError = false;
    try {
      const result = await handler();
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
  // 1. list_mcp_sessions — recent MCP session history
  // ========================================================================
  tool(
    "list_mcp_sessions",
    `List recently recorded MCP sessions as markdown, including transport, client, call count, error count, and last activity.

Use this to find previous sessions before calling get_mcp_session. Results are paged. ${mcpTranscriptExcerptHint}`,
    {
      limit: z.number().int().min(1).max(100).optional().default(20).describe("Max sessions to return (default 20, max 100)"),
      offset: z.number().int().min(0).optional().default(0).describe("Number of sessions to skip for paging"),
    },
    READS,
    async (params, extra) => instrumentToolCall("list_mcp_sessions", params, extra, async () => {
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      const sessions = listMcpSessions({ limit, offset }, getMcpHistoryDb());
      return {
        content: [{ type: "text" as const, text: renderMcpSessionListMarkdown(sessions) }],
      };
    }),
  );

  // ========================================================================
  // 2. get_mcp_session — one MCP session transcript
  // ========================================================================
  tool(
    "get_mcp_session",
    `Render one recorded MCP session transcript as markdown.

If session_id is omitted, this defaults to the caller's own recorded MCP session when available. For stdio clients, sessions are per process, so a fresh stdio process may have little or no own transcript; use list_mcp_sessions or search_mcp_tool_calls for older history. Results are paged. ${mcpTranscriptExcerptHint}`,
    {
      session_id: z.string().min(1).optional().describe("MCP session id to render. Omit to inspect the caller's own session when available."),
      limit: z.number().int().min(1).max(200).optional().default(100).describe("Max tool calls to include (default 100, max 200)"),
      offset: z.number().int().min(0).optional().default(0).describe("Number of tool calls to skip for paging"),
    },
    READS,
    async (params, extra) => instrumentToolCall("get_mcp_session", params, extra, async () => {
      const sessionId = params.session_id ?? getCallerSessionId(extra);
      const limit = params.limit ?? 100;
      const offset = params.offset ?? 0;
      if (!sessionId) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Error: session_id is required because this MCP request did not include a caller session id. Use list_mcp_sessions or search_mcp_tool_calls to inspect recorded history.",
          }],
        };
      }

      const historyDb = getMcpHistoryDb();
      const session = getMcpSession(sessionId, historyDb);
      if (!session) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: MCP session not found: ${sessionId}` }],
        };
      }

      const calls = listMcpToolCalls(sessionId, { limit, offset }, historyDb);
      const stats = getMcpSessionStats(sessionId, historyDb);
      return {
        content: [{ type: "text" as const, text: renderMcpSessionMarkdown(session, calls, stats) }],
      };
    }),
  );

  // ========================================================================
  // 3. search_mcp_tool_calls — cross-session MCP call search
  // ========================================================================
  tool(
    "search_mcp_tool_calls",
    `Search recorded MCP tool calls across sessions and render matching calls as markdown.

Filters are composable: session_id scopes to one session, tool_name scopes to one tool, errors_only keeps failed calls, and since accepts an ISO timestamp with timezone. Results are paged, newest first. ${mcpTranscriptExcerptHint}`,
    {
      session_id: z.string().min(1).optional().describe("Optional session id to scope the search"),
      tool_name: z.string().min(1).optional().describe("Optional exact tool name filter"),
      errors_only: z.boolean().optional().default(false).describe("Only return tool calls recorded as errors"),
      since: z.string().optional().describe("Only return calls created at or after this ISO timestamp with timezone"),
      limit: z.number().int().min(1).max(200).optional().default(100).describe("Max tool calls to return (default 100, max 200)"),
      offset: z.number().int().min(0).optional().default(0).describe("Number of tool calls to skip for paging"),
    },
    READS,
    async (params, extra) => instrumentToolCall("search_mcp_tool_calls", params, extra, async () => {
      const errorsOnly = params.errors_only ?? false;
      const limit = params.limit ?? 100;
      const offset = params.offset ?? 0;
      const historyDb = getMcpHistoryDb();
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
        sessionId: params.session_id,
        toolName: params.tool_name,
        isError: errorsOnly,
        since,
        limit,
        offset,
      }, historyDb);
      return {
        content: [{
          type: "text" as const,
          text: renderMcpCallSearchMarkdown(calls, {
            sessionId: params.session_id,
            toolName: params.tool_name,
            errorsOnly,
            since: params.since,
            limit,
            offset,
          }),
        }],
      };
    }),
  );

  // ========================================================================
  // 4. query_events — unified search/browse/filter
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
      limit: z.number().int().min(1).optional().default(50).describe("Max results (default 50)"),
      cursor: cursorParam,
      full_content: z.boolean().optional().default(false).describe("Return full content instead of truncated previews"),
      group_by_conversation: groupParam,
    },
    READS,
    async (params, extra) => instrumentToolCall("query_events", params, extra, async () => {
      const { query, source, type, contact, date, start_date, end_date, location, latitude, longitude, radius_km, cursor, full_content } = params;
      const limit = params.limit ?? 50;
      const cursorError = invalidCursor(cursor);
      if (cursorError) return cursorError;
      // One more than asked for tells whether more exist without counting them all.
      const fetchLimit = limit + 1;
      const order: PageOrder = rangeOrder(date, start_date, end_date);
      const respond = async (page: { events: TimelineEvent[]; header: string }, prefix = "") => ({
        content: [{
          type: "text" as const,
          text: prefix + page.header + (await formatEvents(db, page.events, full_content)),
        }],
      });

      // `date` narrows to that single day; like getEvents, it wins over start/end.
      // searchTimeline/searchByContact expand a bare YYYY-MM-DD endDate to end of day.
      const rangeStart = date ?? start_date;
      const rangeEnd = date ?? end_date;

      if (params.group_by_conversation) {
        return groupedQueryEvents(db, { ...params, limit, startDate: rangeStart, endDate: rangeEnd });
      }

      // Strategy 1: Contact-based search
      if (contact) {
        const resolved = await resolveContact(db, contact);
        if (resolved.error) {
          return { content: resolved.error, isError: true };
        }

        const aliases = await getAliasesForContact(db, resolved.contact.id);
        const filters = { query, source, type, startDate: rangeStart, endDate: rangeEnd };
        const fetched = await searchByContact(db, resolved.contact.id, { ...filters, cursor, limit: fetchLimit });
        // The location filter runs after the fetch, so the count would not match it.
        const total = location
          ? undefined
          : await countContactEvents(db, resolved.contact.id, filters, CONTACT_COUNT_CAP + 1);
        const lowerLoc = location?.toLowerCase();
        const page = pageOf(fetched, limit, order, {
          total,
          untimedCursor: true,
          filter: lowerLoc ? (e) => e.location_name?.toLowerCase().includes(lowerLoc) ?? false : undefined,
        });

        const header = [
          `Contact: ${resolved.contact.display_name} (ID: ${resolved.contact.id})`,
          `Aliases: ${aliases.map((a) => a.source ? `${a.alias} (${a.source})` : a.alias).join(", ") || "none"}`,
          "",
        ].join("\n");

        return respond(page, header);
      }

      // Strategy 2: Location-based search (name or coordinates)
      if (location || (latitude !== undefined && longitude !== undefined)) {
        const fetched = await searchByLocation(db, {
          locationName: location,
          latitude,
          longitude,
          radiusKm: radius_km,
          limit: fetchLimit,
        });
        if (cursor) {
          return { isError: true, content: [{ type: "text" as const, text: "Error: a location search has no next page; raise limit instead." }] };
        }
        const keep = locationSearchFilter({ query, source, type, date, start_date, end_date });
        // searchByLocation has no cursor.
        return respond(pageOf(fetched, limit, location ? "newest first" : "oldest first", { pageable: false, filter: keep }));
      }

      // Strategy 3: Text search (FTS)
      if (query) {
        const fetched = await searchTimeline(db, {
          // MCP is an agent data-access seam and remains intentionally unfiltered.
          includeHiddenContacts: true,
          query,
          source,
          type,
          startDate: rangeStart,
          endDate: rangeEnd,
          cursor,
          limit: fetchLimit,
        });
        return respond(pageOf(fetched, limit, order, { untimedCursor: true }));
      }

      // Strategy 4: Date-based browsing
      if (date || start_date || end_date) {
        const fetched = await getEvents(db, {
          // MCP is an agent data-access seam and remains intentionally unfiltered.
          includeHiddenContacts: true,
          date,
          startDate: start_date,
          endDate: end_date,
          source,
          type,
          cursor,
          limit: fetchLimit,
        });
        return respond(pageOf(fetched, limit, order));
      }

      // Strategy 5: Fallback — recent events (filtered by source/type)
      // MCP is an agent data-access seam and remains intentionally unfiltered.
      const fetched = await getRecentEvents(db, { source, type, cursor, limit: fetchLimit, includeHiddenContacts: true });
      return respond(pageOf(fetched, limit, "newest first"));
    })
  );

  // ========================================================================
  // 5. export_conversation — full untruncated conversation transcript
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
    },
    READS,
    async (params, extra) => instrumentToolCall("export_conversation", params, extra, async () => {
      const { conversation_id, event_id, start_date, end_date } = params;
      const limit = params.limit ?? MCP_EXPORT_LIMIT;

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
        if (!event) {
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

      const result = await exportConversation(db, {
        conversationId,
        startDate: start_date,
        endDate: expandEndDateToEndOfDay(end_date),
      }, {
        limit,
        source: conversationSource,
        mostRecent: true,
        includeTotal: true,
        aroundEventId: event_id !== undefined && start_date === undefined && end_date === undefined
          ? event_id
          : undefined,
        compactAuthors: true,
        noSummaries: false,
        fullTimestamps: false,
      });
      const limitNote = result.totalEventCount !== undefined && result.totalEventCount > result.events.length
        ? event_id !== undefined && start_date === undefined && end_date === undefined
          ? `Showing ${result.events.length} of ${result.totalEventCount} events around event #${event_id}.`
          : `Showing most recent ${result.events.length} of ${result.totalEventCount} events.`
        : undefined;
      const metadata = [
        `Conversation: ${result.conversationId}`,
        `Events: ${result.events.length}`,
        ...(limitNote ? [limitNote] : []),
        `Transcript tokens: ${result.tokenCount ?? 0}.`,
      ];

      return {
        content: [{ type: "text" as const, text: withTranscriptMetadata(metadata, result.text) }],
      };
    }),
  );

  // ========================================================================
  // 6. get_context — events around a specific time
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
      limit: z.number().int().min(1).optional().default(50).describe("Max results (default 50)"),
      cursor: cursorParam,
      full_content: z.boolean().optional().default(false).describe("Return full content instead of truncated previews"),
    },
    READS,
    async (params, extra) => instrumentToolCall("get_context", params, extra, async () => {
      const { event_id, timestamp, hours_window, source, exclude_source, cursor, full_content } = params;
      const limit = params.limit ?? 50;
      const cursorError = invalidCursor(cursor);
      if (cursorError) return cursorError;
      const fetched = await getEventContext(db, {
        eventId: event_id,
        timestamp,
        hoursWindow: hours_window,
        sources: splitSources(source),
        excludeSources: splitSources(exclude_source),
        cursor,
        limit: limit + 1,
      });
      const page = pageOf(fetched, limit, "oldest first");

      return {
        content: [{
          type: "text" as const,
          text: page.header + (await formatEvents(db, page.events, full_content)),
        }],
      };
    })
  );

  // ========================================================================
  // 7. get_summary — period summary or global stats
  // ========================================================================
  tool(
    "get_summary",
    `Get a summary of timeline data. With date params, returns an aggregated breakdown for that period. Without date params, returns global stats (total events, date range, source counts). Source filters apply to both.`,
    {
      date: z.string().optional().describe("Single date (YYYY-MM-DD)"),
      start_date: z.string().optional().describe("Start of range (ISO 8601)"),
      end_date: z.string().optional().describe("End of range (ISO 8601)"),
      source: z.string().optional().describe("Only include these sources (comma-separated, e.g. \"discord,spotify\")"),
      exclude_source: z.string().optional().describe("Drop these sources from the summary (comma-separated) — e.g. \"claude-code,conductor,t3code,codex\" to hide AI agent-session noise, or \"spotify-friends\" to hide friends' activity"),
    },
    READS,
    async (params, extra) => instrumentToolCall("get_summary", params, extra, async () => {
      const { date, start_date, end_date, source, exclude_source } = params;
      const includeSources = splitSources(source);
      const excludeSources = splitSources(exclude_source);
      // No date params → global stats overview (source filters applied to the cached stats)
      if (!date && !start_date && !end_date) {
        const stats = await getStats(db, writeDb);
        const visibleSources = stats.sources.filter(
          (s) =>
            (!includeSources || includeSources.includes(s.source)) &&
            !excludeSources?.includes(s.source)
        );
        const filtered = includeSources !== undefined || excludeSources !== undefined;
        const totalEvents = filtered
          ? visibleSources.reduce((sum, s) => sum + s.count, 0)
          : stats.total_events;

        const lines = [
          `Total events: ${totalEvents}`,
          `Date range: ${stats.date_range.earliest || "N/A"} to ${stats.date_range.latest || "N/A"}`,
          "",
          "Events by source:",
        ];

        const grouped: Record<string, Record<string, number>> = {};
        for (const s of visibleSources) {
          if (!grouped[s.source]) grouped[s.source] = {};
          grouped[s.source][s.type] = s.count;
        }

        for (const [source, types] of Object.entries(grouped)) {
          const total = Object.values(types).reduce((a, b) => a + b, 0);
          lines.push(`  ${source}: ${total}`);
          for (const [type, count] of Object.entries(types)) {
            lines.push(`    - ${type}: ${count}`);
          }
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }

      // Date params → period summary
      const summary = await getSummary(db, {
        date,
        startDate: start_date,
        endDate: end_date,
        sources: includeSources,
        excludeSources,
      });

      if (summary.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No events found for this time period." }],
        };
      }

      const lines: string[] = [];
      for (const s of summary) {
        if (s.conversations && s.conversations.length > 0) {
          // Message types: show per-conversation breakdown
          lines.push(`${s.source}/${s.type}: ${s.count}`);
          for (const conv of s.conversations) {
            lines.push(`  - ${conv.name}: ${conv.count}`);
          }
        } else {
          // Non-message types: show sample titles
          const samples = s.sample_titles.length > 0 ? ` (e.g., ${s.sample_titles.slice(0, 3).join(", ")})` : "";
          lines.push(`${s.source}/${s.type}: ${s.count}${samples}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    })
  );

  // ========================================================================
  // 8. get_schema — DB schema + source catalog, or raw_data JSON paths
  // ========================================================================
  tool(
    "get_schema",
    `How to query the database with run_sql: tables, columns, conventions, worked queries and the sources. With source, that source's types and the raw_data JSON paths for json_extract().`,
    {
      source: z.string().optional().describe("Source to inspect raw_data JSON structure (spotify, discord, monzo, etc.)"),
      type: z.string().optional().describe("Optional type filter when inspecting raw_data"),
    },
    READS,
    async (params, extra) => instrumentToolCall("get_schema", params, extra, async () => {
      const { source, type } = params;
      // Source specified → raw_data JSON schema
      if (source) {
        const schema = await getRawDataSchema(db, { source, type });

        if (schema.sampleCount === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No events found for source="${source}"${type ? ` type="${type}"` : ""}`,
            }],
          };
        }

        const types = await db.query<{ type: string; n: number }>(
          "SELECT type, count(*) AS n FROM events WHERE source = ? GROUP BY type ORDER BY n DESC",
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
          "Sample (truncated):",
          JSON.stringify(schema.sample, null, 2),
        ];

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }

      // No params → what a model needs to write SQL, and the sources.
      // MCP is an agent data-access seam and remains intentionally unfiltered.
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
  // 9. run_sql — raw SELECT queries
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
    READS,
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

      const tsv = toTSV(result.rows);
      const header = result.count > 150 ? `Showing 150 of ${result.count} rows\n` : "";

      return {
        content: [{ type: "text" as const, text: header + tsv }],
      };
    })
  );

  // ========================================================================
  // 10. list_contacts — unchanged
  // ========================================================================
  tool(
    "list_contacts",
    "List all contacts in the timeline. Contacts link people across platforms (e.g., same person on Discord, Skype, Facebook).",
    {
      include_hidden: z.boolean().optional().default(false).describe("Include hidden contacts"),
      search: z.string().optional().describe("Filter by name; also accepts a platform identifier (e.g. discord:123…, phone:+44…, or a bare Discord snowflake) to look up the linked contact"),
    },
    READS,
    async (params, extra) => instrumentToolCall("list_contacts", params, extra, async () => {
      const { include_hidden, search } = params;
      let contacts = await listContacts(db, {
        includeHidden: include_hidden,
        search,
      });

      // Identity-aware fallback: if the name search came up empty, the search
      // term might be a platform identifier (e.g. a Discord snowflake the
      // caller pulled out of message content). Probe the identities table.
      if (contacts.length === 0 && search) {
        const identity = await resolveContactByIdentity(db, search);
        if (identity) {
          const ids = "ambiguous" in identity
            ? identity.ambiguous.map((r) => r.contact_id)
            : [identity.contactId];
          contacts = await listContacts(db, {
            includeHidden: include_hidden,
            ids,
          });
        }
      }

      if (contacts.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No contacts found." }],
        };
      }

      const lines = contacts.map((c) => {
        const hiddenTag = c.hidden ? " [HIDDEN]" : "";
        const notesTag = c.notes ? ` - ${c.notes}` : "";
        const detailsTag = c.date_of_birth ? ` [DOB: ${formatBirthdayForDisplay(c.date_of_birth)}]` : "";
        const platformLabel = c.platformCount === 1 ? "platform" : "platforms";
        const activeIdentityLabel = c.activeIdentityCount === 1 ? "active identity" : "active identities";
        return `${c.id}. ${c.display_name}${hiddenTag}${detailsTag} (${c.platformCount} ${platformLabel} · ${c.activeIdentityCount} ${activeIdentityLabel} · ${c.eventCount} events)${notesTag}`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    })
  );

  // ========================================================================
  // 11. get_contact_info — unchanged
  // ========================================================================
  tool(
    "get_contact_info",
    "Get detailed profile information for a contact including structured fields (birthday, location, email, phone), notes, identities, and AI memories. Accepts a contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…, or a bare snowflake from a Discord <@id> mention).",
    {
      contact: z.string().describe("Contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…, or a bare Discord snowflake)"),
    },
    READS,
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

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    })
  );

  // ========================================================================
  // 12. remember_contact_fact — unchanged
  // ========================================================================
  tool(
    "remember_contact_fact",
    "Store a fact or memory about a contact. Use this when you learn something about a person during conversation that would be useful to remember for future interactions.",
    {
      contact: z.string().describe("Contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…)"),
      fact: z.string().describe("The fact or memory to store (e.g., 'Prefers tea over coffee', 'Works at Acme Corp', 'Has a dog named Max')"),
    },
    WRITES,
    async (params, extra) => instrumentToolCall("remember_contact_fact", params, extra, async () => {
      const { contact, fact } = params;
      if (!writeDb) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Storing memories requires a writable database connection.",
          }],
        };
      }

      const resolved = await resolveContact(db, contact);
      if (resolved.error) {
        return { content: resolved.error, isError: true };
      }

      const contactObj = resolved.contact;
      const memory = createContactMemory(writeDb, contactObj.id, fact);
      return {
        content: [{
          type: "text" as const,
          text: `Stored memory for ${contactObj.display_name}: "${fact}" (ID: ${memory.id})`,
        }],
      };
    })
  );

  // ========================================================================
  // 13. semantic_search — vector similarity search over indexed events
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
    READS,
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

      // Present only once a conversation-window pilot has indexed some windows.
      const windowSection = windows.length > 0
        ? `\n\n${windows.length} conversation window(s) most similar, closest first; each is a stretch of one conversation, and its #id opens it with export_conversation:\n${windows.map(formatWindowHit).join("\n")}`
        : windowsError ? `\n\nConversation windows could not be searched: ${windowsError}` : "";

      if (hits.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No events found near "${query}". The index may be empty for this model — run \`bun run embeddings index\` first.${windowSection}`,
          }],
        };
      }

      // hits come back closest-first; a document can map to several events and
      // KNN bounds documents, not events, so dedupe to unique events in that
      // order and cap to the requested count after dropping any whose row no
      // longer exists in timeline.db.
      const { events, missingCount } = await hydrateEventsById(
        db,
        hits.map((hit) => hit.event_id),
        { limit },
      );

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

      return {
        content: [{
          type: "text" as const,
          text: header + (await formatEvents(db, events, full_content)) + windowSection,
        }],
      };
    })
  );

  // ========================================================================
  // 14-17. Shared memory: notes any connected agent can read and write
  // ========================================================================
  const memoryError = (error: unknown): CallToolResult => ({
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
  });
  const projectParam = z.string().optional().describe("Repository name; omit for account notes");
  const nameParam = z.string().max(MEMORY_LIMITS.name).describe("Lowercase slug, unique in its scope");

  tool(
    "list_memory",
    "Index of the user's shared memory: each note's name, title, summary and update date, by kind. With project, that project's notes come first, then the account's, which apply everywhere.",
    { project: projectParam },
    READS,
    async (params, extra) => instrumentToolCall("list_memory", params, extra, async () => {
      try {
        const project = projectScope(params.project);
        const db = getMcpHistoryDb();
        const index = renderMemoryIndex(listMemoryNotes(db, project), project, projectUsesAccountMemory(db, project));
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
    READS,
    async (params, extra) => instrumentToolCall("get_memory_note", params, extra, async () => {
      try {
        const project = projectScope(params.project);
        const note = getMemoryNote(getMcpHistoryDb(), project, params.name);
        if (!note) {
          return memoryError(`No note named "${params.name}" in ${project ? `project ${project}` : "the account"}.`);
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
      contact: z.string().optional().describe("Contact to link, as get_contact_info takes; \"\" unlinks"),
    },
    WRITES,
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
    WRITES,
    async (params, extra) => instrumentToolCall("delete_memory_note", params, extra, async () => {
      try {
        const project = projectScope(params.project);
        const note = deleteMemoryNote(getMcpHistoryDb(), project, params.name);
        if (!note) {
          return memoryError(`No note named "${params.name}" in ${project ? `project ${project}` : "the account"}.`);
        }
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
    READS,
    async (params, extra) => instrumentToolCall("get_updates", params, extra, () => runGetUpdates(db, params)),
  );
}
