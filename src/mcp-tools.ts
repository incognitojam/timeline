/**
 * MCP Tools Registration
 *
 * Shared tool definitions for both stdio and HTTP MCP transports.
 * 13 tools: list_mcp_sessions, get_mcp_session, search_mcp_tool_calls,
 *           query_events, get_context, get_summary, get_schema, run_sql,
 *           list_contacts, get_contact_info, remember_contact_fact,
 *           semantic_search, export_conversation
 */

import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, RequestId, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAppStateDb } from "./db/app-state";
import { resolveIdentities } from "./db/identities";
import type { QueryExecutor } from "./db/pool";
import {
  createContactMemory,
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
  runReadOnlySql,
  searchByContact,
  searchByLocation,
  searchTimeline,
} from "./db/queries";
import type { TimelineEvent } from "./db/schema";
import { notConfiguredMessage } from "./embeddings/config";
import { type SemanticSearch, searchEmbeddings } from "./embeddings/search";
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
import { discordMentionsToPlainText, extractUserMentionIds } from "./shared/discord-mentions";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MCP_EXPORT_LIMIT = 500;

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

/**
 * Format events for display. Resolves the sender (people[0]) for every event
 * and Discord <@id> mentions in content via a single batched identities lookup,
 * so the LLM sees `<Alice Example>` and `@Alice Example` instead of raw IDs.
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
    if (e.source === "discord" && e.content) {
      for (const id of extractUserMentionIds(e.content)) {
        identifiers.add(`discord:${id}`);
      }
    }
  }

  const resolved = identifiers.size > 0
    ? await resolveIdentities(db, [...identifiers])
    : {};

  const discordUserResolver = (id: string): string | null =>
    resolved[`discord:${id}`]?.name ?? null;

  return events
    .map((e) => {
      const parts = [`#${e.id}`, `[${e.source}/${e.type}]`];

      if (e.timestamp) {
        parts.push(e.timestamp);
      }

      // For messages: [title] <sender> content
      if (e.type?.startsWith("message")) {
        let people: string[] = [];
        try {
          if (e.people) people = JSON.parse(e.people);
        } catch {}

        const sender = people[0];
        const attachments = getAttachmentDescription(e);
        const markers = getMessageMarkers(e, attachments);
        const rawText = e.content && markers.length > 0
          ? `${e.content} ${markers.join(" ")}`
          : e.content || markers.join(" ");
        // Resolve <@id> / <#id> / <:emoji:id> in Discord content before truncation.
        const text = rawText && e.source === "discord"
          ? discordMentionsToPlainText(rawText, e.raw_data, { user: discordUserResolver })
          : rawText;
        const truncated = fullContent || !text ? text : (text.length > 150 ? text.slice(0, 150) + "..." : text);

        // [title] <sender> content
        // Skip title if it matches content (legacy Facebook data stored message in title)
        const titleIsContent = e.title && e.content &&
          (e.title === e.content || e.content.startsWith(e.title.replace(/\.\.\.$/,'')) || e.title.startsWith(e.content.slice(0, 50)));
        if (e.title && !titleIsContent) parts.push(`[${e.title}]`);
        if (sender) {
          const senderName = resolved[sender]?.name;
          parts.push(senderName ? `<${senderName}>` : `<${sender}>`);
        }
        if (truncated) parts.push(truncated);
      } else {
        // Non-messages: show title and content separately
        if (e.title) {
          parts.push(e.title);
        }
        if (e.content && e.content !== e.title) {
          const content = fullContent ? e.content : (e.content.length > 100 ? e.content.slice(0, 100) + "..." : e.content);
          parts.push(`- ${content}`);
        }
      }

      if (e.location_name) {
        parts.push(`@ ${e.location_name}`);
      }

      return parts.join(" ");
    })
    .join("\n");
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
 * Format source stats into a grouped source catalog string.
 */
function formatSourceCatalog(sources: { source: string; type: string; count: number }[]): string {
  const grouped: Record<string, { types: Record<string, number>; total: number }> = {};
  for (const s of sources) {
    if (!grouped[s.source]) {
      grouped[s.source] = { types: {}, total: 0 };
    }
    grouped[s.source].types[s.type] = s.count;
    grouped[s.source].total += s.count;
  }

  return Object.entries(grouped)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([source, data]) => {
      const types = Object.entries(data.types)
        .map(([t, c]) => `${t}: ${c}`)
        .join(", ");
      return `  ${source} (${data.total}): ${types}`;
    })
    .join("\n");
}

/**
 * Build the trailing paragraph appended to every formatted-events tool's
 * description, telling the agent that each line begins with `#<id>` and how
 * to turn that id into a clickable timeline-web-app URL when configured.
 */
function eventIdHint(publicUrl?: string): string {
  const url = publicUrl?.replace(/\/$/, "");
  const linkLine = url
    ? `Open in browser at ${url}/event/<id> — the timeline scrolls to and highlights the event (for chat messages the conversation pane also auto-opens).`
    : "Open in the timeline web app at <your-host>/event/<id>.";
  return `Each event line begins with \`#<id>\` (the stable timeline event id). ${linkLine} Pass an \`<id>\` to \`get_context\` via \`event_id\` to see surrounding events.`;
}

/** Split a comma-separated source list param into trimmed names (undefined when absent/empty). */
function splitSources(value: string | undefined): string[] | undefined {
  const sources = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return sources && sources.length > 0 ? sources : undefined;
}

export interface RegisterToolsOptions {
  /** Public URL of the timeline web app (e.g. "https://timeline.example.ts.net"). Spliced into tool descriptions when set. */
  publicUrl?: string;
  /** Optional recorder used by transports to persist MCP tool call metadata. */
  recordToolCall?: (rec: ToolCallRecord) => void;
  /** Optional app-state database for MCP session history tools. Resolved lazily when omitted. */
  appStateDb?: Database;
  /** Fallback session id for transports, such as stdio, whose SDK extra has no session id. */
  defaultSessionId?: () => string | undefined;
  /** Embedding model and index for semantic_search; unset leaves the tool returning a setup message. */
  semanticSearch?: SemanticSearch;
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
  const idHint = eventIdHint(options.publicUrl);
  const recordToolCall = options.recordToolCall;
  const getMcpHistoryDb = (): Database => options.appStateDb ?? getAppStateDb();
  const getCallerSessionId = (extra?: ToolCallExtra): string | undefined =>
    extra?.sessionId ?? options.defaultSessionId?.();
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
  server.tool(
    "list_mcp_sessions",
    `List recently recorded MCP sessions as markdown, including transport, client, call count, error count, and last activity.

Use this to find previous sessions before calling get_mcp_session. Results are paged. ${mcpTranscriptExcerptHint}`,
    {
      limit: z.number().int().min(1).max(100).optional().default(20).describe("Max sessions to return (default 20, max 100)"),
      offset: z.number().int().min(0).optional().default(0).describe("Number of sessions to skip for paging"),
    },
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
  server.tool(
    "get_mcp_session",
    `Render one recorded MCP session transcript as markdown.

If session_id is omitted, this defaults to the caller's own recorded MCP session when available. For stdio clients, sessions are per process, so a fresh stdio process may have little or no own transcript; use list_mcp_sessions or search_mcp_tool_calls for older history. Results are paged. ${mcpTranscriptExcerptHint}`,
    {
      session_id: z.string().min(1).optional().describe("MCP session id to render. Omit to inspect the caller's own session when available."),
      limit: z.number().int().min(1).max(200).optional().default(100).describe("Max tool calls to include (default 100, max 200)"),
      offset: z.number().int().min(0).optional().default(0).describe("Number of tool calls to skip for paging"),
    },
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
  server.tool(
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
  server.tool(
    "query_events",
    `Search and filter timeline events. All parameters are optional and composable.

Returns formatted event list, newest first by default (oldest first when date range is specified).

${idHint}

Examples:
- Text search: query_events(query: "hiking")
- Date browsing: query_events(date: "2025-06-15")
- Recent by source: query_events(source: "spotify")
- Contact events: query_events(contact: "Alice", source: "discord")
- Location: query_events(location: "London")
- Coordinates: query_events(latitude: 51.5, longitude: -0.12)
- Combined: query_events(query: "project", contact: "Bob", start_date: "2025-01-01")`,
    {
      query: z.string().optional().describe('Text search across titles, content, and location names. Words match as ANDed prefix tokens with punctuation ignored (e.g. "board-games" also matches text mentioning board and games separately); wrap the whole query in double quotes to require the exact phrase'),
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
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
      full_content: z.boolean().optional().default(false).describe("Return full content instead of truncated previews"),
    },
    async (params, extra) => instrumentToolCall("query_events", params, extra, async () => {
      const { query, source, type, contact, date, start_date, end_date, location, latitude, longitude, radius_km, limit, full_content } = params;
      let events: TimelineEvent[];

      // `date` narrows to that single day; like getEvents, it wins over start/end.
      // searchTimeline/searchByContact expand a bare YYYY-MM-DD endDate to end of day.
      const rangeStart = date ?? start_date;
      const rangeEnd = date ?? end_date;

      // Strategy 1: Contact-based search
      if (contact) {
        const resolved = await resolveContact(db, contact);
        if (resolved.error) {
          return { content: resolved.error, isError: true };
        }

        const aliases = await getAliasesForContact(db, resolved.contact.id);
        events = await searchByContact(db, resolved.contact.id, {
          query,
          source,
          type,
          startDate: rangeStart,
          endDate: rangeEnd,
          limit,
        });

        // Post-filter for location if provided
        if (location) {
          const lowerLoc = location.toLowerCase();
          events = events.filter(e => e.location_name?.toLowerCase().includes(lowerLoc));
        }

        const header = [
          `Contact: ${resolved.contact.display_name} (ID: ${resolved.contact.id})`,
          `Aliases: ${aliases.map((a) => a.source ? `${a.alias} (${a.source})` : a.alias).join(", ") || "none"}`,
          `Events found: ${events.length}`,
          "",
        ].join("\n");

        return {
          content: [{
            type: "text" as const,
            text: header + (await formatEvents(db, events, full_content)),
          }],
        };
      }

      // Strategy 2: Location-based search (name or coordinates)
      if (location || (latitude !== undefined && longitude !== undefined)) {
        events = await searchByLocation(db, {
          locationName: location,
          latitude,
          longitude,
          radiusKm: radius_km,
          limit,
        });

        // Post-filter for text, source, type, date
        if (query) {
          const lowerQuery = query.toLowerCase();
          events = events.filter(e =>
            e.title?.toLowerCase().includes(lowerQuery) ||
            e.content?.toLowerCase().includes(lowerQuery)
          );
        }
        if (source) {
          const sources = new Set(source.split(",").map(s => s.trim()));
          events = events.filter(e => sources.has(e.source));
        }
        if (type) {
          const types = type.split(",").map(t => t.trim());
          events = events.filter(e => types.some(t => e.type.startsWith(t)));
        }
        if (date) {
          events = events.filter(e => e.timestamp?.startsWith(date));
        }
        if (start_date) {
          events = events.filter(e => e.timestamp && e.timestamp >= start_date);
        }
        if (end_date) {
          const endValue = expandEndDateToEndOfDay(end_date);
          events = events.filter(e => e.timestamp && endValue && e.timestamp <= endValue);
        }

        return {
          content: [{
            type: "text" as const,
            text: await formatEvents(db, events, full_content),
          }],
        };
      }

      // Strategy 3: Text search (FTS)
      if (query) {
        events = await searchTimeline(db, {
          // MCP is an agent data-access seam and remains intentionally unfiltered.
          includeHiddenContacts: true,
          query,
          source,
          type,
          startDate: rangeStart,
          endDate: rangeEnd,
          limit,
        });

        return {
          content: [{
            type: "text" as const,
            text: await formatEvents(db, events, full_content),
          }],
        };
      }

      // Strategy 4: Date-based browsing
      if (date || start_date || end_date) {
        events = await getEvents(db, {
          // MCP is an agent data-access seam and remains intentionally unfiltered.
          includeHiddenContacts: true,
          date,
          startDate: start_date,
          endDate: end_date,
          source,
          type,
          limit,
        });

        return {
          content: [{
            type: "text" as const,
            text: await formatEvents(db, events, full_content),
          }],
        };
      }

      // Strategy 5: Fallback — recent events (filtered by source/type)
      // MCP is an agent data-access seam and remains intentionally unfiltered.
      events = await getRecentEvents(db, { source, type, limit, includeHiddenContacts: true });

      return {
        content: [{
          type: "text" as const,
          text: await formatEvents(db, events, full_content),
        }],
      };
    })
  );

  // ========================================================================
  // 5. export_conversation — full untruncated conversation transcript
  // ========================================================================
  server.tool(
    "export_conversation",
    "Export a full conversation transcript in markdown. Unlike query_events, this returns untruncated message content in chronological order. Pass either a conversation_id or an event_id from the #<id> prefix in query_events output.",
    {
      conversation_id: z.string().min(1).optional().describe("Conversation id to export. Provide exactly one of conversation_id or event_id."),
      event_id: z.number().int().positive().optional().describe("Timeline event id from query_events output. Provide exactly one of conversation_id or event_id; without date bounds, centers the limited window on this event."),
      limit: z.number().int().min(1).max(2000).optional().default(MCP_EXPORT_LIMIT).describe("Maximum events to render (default 500, max 2000). conversation_id alone returns the newest events; event_id returns a window around that event."),
      start_date: z.string().optional().describe("Inclusive ISO 8601 lower timestamp bound. Any date bound overrides event_id centering."),
      end_date: z.string().optional().describe("Inclusive ISO 8601 upper timestamp bound. Any date bound overrides event_id centering."),
    },
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
      if (event_id !== undefined) {
        const event = await db.get<{ conversation_id: string | null }>(
          "SELECT conversation_id FROM events WHERE id = ?",
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
  server.tool(
    "get_context",
    `Get events surrounding a specific event or timestamp to understand context.

${idHint}`,
    {
      event_id: z.number().optional().describe("Event ID to center the context around"),
      timestamp: z.string().optional().describe("Timestamp to center around (ISO 8601)"),
      hours_window: z.number().optional().default(2).describe("Hours before and after to include (default 2)"),
      source: z.string().optional().describe("Only include these sources (comma-separated, e.g. \"discord,spotify\")"),
      exclude_source: z.string().optional().describe("Drop these sources from the window (comma-separated) — e.g. \"claude-code,conductor,t3code,codex\" to hide AI agent-session noise"),
      limit: z.number().optional().default(50).describe("Max results (default 50)"),
      full_content: z.boolean().optional().default(false).describe("Return full content instead of truncated previews"),
    },
    async (params, extra) => instrumentToolCall("get_context", params, extra, async () => {
      const { event_id, timestamp, hours_window, source, exclude_source, limit, full_content } = params;
      const events = await getEventContext(db, {
        eventId: event_id,
        timestamp,
        hoursWindow: hours_window,
        sources: splitSources(source),
        excludeSources: splitSources(exclude_source),
        limit,
      });

      return {
        content: [{
          type: "text" as const,
          text: await formatEvents(db, events, full_content),
        }],
      };
    })
  );

  // ========================================================================
  // 7. get_summary — period summary or global stats
  // ========================================================================
  server.tool(
    "get_summary",
    `Get a summary of timeline data. With date params, returns an aggregated breakdown for that period. Without date params, returns global stats (total events, date range, source counts). Source filters apply to both.`,
    {
      date: z.string().optional().describe("Single date (YYYY-MM-DD)"),
      start_date: z.string().optional().describe("Start of range (ISO 8601)"),
      end_date: z.string().optional().describe("End of range (ISO 8601)"),
      source: z.string().optional().describe("Only include these sources (comma-separated, e.g. \"discord,spotify\")"),
      exclude_source: z.string().optional().describe("Drop these sources from the summary (comma-separated) — e.g. \"claude-code,conductor,t3code,codex\" to hide AI agent-session noise, or \"spotify-friends\" to hide friends' activity"),
    },
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
  server.tool(
    "get_schema",
    `Get database schema information. Without params, returns full schema (tables, columns, indexes) and source catalog. With source param, returns raw_data JSON paths for use with json_extract() in SQL.`,
    {
      source: z.string().optional().describe("Source to inspect raw_data JSON structure (spotify, discord, monzo, etc.)"),
      type: z.string().optional().describe("Optional type filter when inspecting raw_data"),
    },
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

        const lines = [
          `Source: ${source}${type ? ` (type: ${type})` : ""}`,
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

      // No params → full schema overview + source catalog
      // MCP is an agent data-access seam and remains intentionally unfiltered.
      const sources = await listSources(db, { includeHiddenContacts: true });

      const lines = [
        "Timeline Database Schema",
        "",
        "events — All timeline data from all sources",
        "  source (text)         — Data source (spotify, discord, reddit, facebook, etc.)",
        "  type (text)           — Event type (listen:track, message:dm, post, etc.)",
        "  timestamp (text)      — ISO 8601 timestamp",
        "  end_timestamp (text)  — End time for duration events",
        "  duration_ms (integer) — Duration in milliseconds",
        "  title (text)          — Event title (song name, chat name, post title)",
        "  content (text)        — Event body (message text, post content)",
        "  people (text)         — JSON array of people [\"platform:id\", ...]",
        "  tags (text)           — JSON array of tags",
        "  location_name (text)  — Human-readable location name",
        "  latitude (real)       — Latitude coordinate",
        "  longitude (real)      — Longitude coordinate",
        "  source_account (text) — Which account (for multi-account sources)",
        "  raw_data (text)       — Original JSON from source (large — use json_extract())",
        "",
        "Full-text search: events_fts (searches title, content, location_name)",
        "",
        "contacts — People linked across platforms",
        "  id, display_name, notes, hidden, date_of_birth, is_self",
        "",
        "identities — Platform-specific identities linked to contacts",
        "  contact_id, platform, platform_id, display_name, username",
        "  (platform_id is searchable directly via list_contacts/get_contact_info — pass a bare Discord snowflake or a `platform:id` string and the lookup will follow it to the linked contact)",
        "",
        "event_people — Index mapping events to people (for contact queries)",
        "  event_id, person, source, timestamp, is_sender",
        "",
        "contact_memories — AI-stored facts about contacts",
        "  contact_id, content, created_at",
        "",
        "Available sources:",
        formatSourceCatalog(sources),
      ];

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    })
  );

  // ========================================================================
  // 9. run_sql — raw SELECT queries
  // ========================================================================
  server.tool(
    "run_sql",
    `Execute SELECT queries for complex analysis beyond what specialized tools provide.
Returns TSV format, max 150 rows. Call get_schema for full table/column details.

${idHint}

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
  server.tool(
    "list_contacts",
    "List all contacts in the timeline. Contacts link people across platforms (e.g., same person on Discord, Skype, Facebook).",
    {
      include_hidden: z.boolean().optional().default(false).describe("Include hidden contacts"),
      search: z.string().optional().describe("Filter by name; also accepts a platform identifier (e.g. discord:123…, phone:+44…, or a bare Discord snowflake) to look up the linked contact"),
    },
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
  server.tool(
    "get_contact_info",
    "Get detailed profile information for a contact including structured fields (birthday, location, email, phone), notes, identities, and AI memories. Accepts a contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…, or a bare snowflake from a Discord <@id> mention).",
    {
      contact: z.string().describe("Contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…, or a bare Discord snowflake)"),
    },
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
  server.tool(
    "remember_contact_fact",
    "Store a fact or memory about a contact. Use this when you learn something about a person during conversation that would be useful to remember for future interactions.",
    {
      contact: z.string().describe("Contact ID, display name, or platform identifier (e.g. discord:123…, phone:+44…)"),
      fact: z.string().describe("The fact or memory to store (e.g., 'Prefers tea over coffee', 'Works at Acme Corp', 'Has a dog named Max')"),
    },
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
  server.tool(
    "semantic_search",
    `Search timeline events by *meaning* using vector embeddings, complementing query_events (which does keyword/FTS matching). Reach for this on conceptual queries where the exact words may not appear in the events — e.g. "times I felt burned out", "planning a trip abroad", "conversations about moving house". Results are ranked by similarity, closest first.

Requires embeddings to be configured and an index to be built (see docs/embeddings.md). When embeddings aren't configured this returns a short setup message instead of results.

${idHint}`,
    {
      query: z.string().trim().min(1).describe("Natural-language query, matched by meaning against indexed event content"),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Max events to return (1-50, default 10)"),
      full_content: z.boolean().optional().default(false).describe("Return full content instead of truncated previews"),
    },
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
      let hits: Awaited<ReturnType<typeof searchEmbeddings>>;
      try {
        hits = await searchEmbeddings(options.semanticSearch, query, candidateLimit);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Semantic search failed: ${message}` }],
        };
      }

      if (hits.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No events found near "${query}". The index may be empty for this model — run \`bun run embeddings index\` first.`,
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
            text: `Semantic search found indexed vector hits for "${query}", but none of their events still exist in timeline.db. The embeddings index may be stale — run \`bun run embeddings index\` after refreshing the database.`,
          }],
        };
      }

      const staleNote = missingCount > 0
        ? ` Skipped ${missingCount} indexed hit(s) whose events no longer exist in timeline.db.`
        : "";
      const header = `${events.length} event(s) most similar to "${query}", closest first (nearest matches by meaning, not exact).${staleNote}\n\n`;

      return {
        content: [{
          type: "text" as const,
          text: header + (await formatEvents(db, events, full_content)),
        }],
      };
    })
  );
}
