/**
 * get_updates: what was added to Timeline since a marker, in one compact reply.
 *
 * "New" means added to Timeline, not dated recently: syncs and exports bring
 * in events long after they happen. events.id is AUTOINCREMENT, so ids only
 * grow and are never reused; a marker is the highest id the reply covered, and
 * the next call asks for ids above it.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { conversationTypeClause } from "../db/conversation-types";
import { hasHiddenContacts, hiddenEventIdsSubquery } from "../db/events";
import type { QueryExecutor } from "../db/pool";
import type { TimelineEvent } from "../db/schema";
import { renderExportText } from "../export/export";
import { countTokens } from "../export/tokens";
import { NOISY_MACHINE_SOURCES } from "../shared/noisy-sources";
import { sourceIdsWithTraits } from "../shared/sources";

/** Daily health records; on a day both report a type, the first source wins. */
const HEALTH_SOURCES = ["google-health", "fitbit"] as const;
const HEALTH_TYPE_ORDER = [
  "sleep", "daily:heart", "daily:hrv", "daily:readiness", "daily:stress", "daily:spo2",
  "daily:breathing", "daily:temperature", "daily:activity", "daily:azm", "daily:weight",
];
const SOCIAL_SOURCES = new Set(sourceIdsWithTraits((traits) => traits.conversation === "social"));
const NOISY_SOURCES = new Set(NOISY_MACHINE_SOURCES);
/** Most messages one conversation shows; the rest are pointed to. */
const GROUP_MESSAGE_LIMIT = 100;
/** Fewest messages a conversation is cut to before the reply stops. */
const GROUP_MESSAGE_MIN = 5;
/** Most conversations one reply shows. */
const GROUP_LIMIT = 40;
/** Not-shown conversations named before the rest are summed. */
const NAMED_LEFT = 10;
/** Most ids one reply covers, so a stale marker costs several bounded calls rather than one walk of the whole table. */
const WINDOW_IDS = 100_000;
/** How far back a date since may reach. */
const DATE_LOOKBACK_DAYS = 31;
/** Stored timestamps carry offsets up to ±14h, so the indexed bound is widened past that and julianday() decides. */
const OFFSET_SLACK_MS = 15 * 3_600_000;
const DAY_MS = 86_400_000;
/** Longest conversation title a heading repeats. */
const TITLE_CHARS = 80;
const MARKER = /^id:(\d+)$/;

export const UPDATES_DEFAULT_MAX_TOKENS = 8000;
export const UPDATES_DEFAULT_HEALTH_DAYS = 14;

export interface UpdatesParams {
  /** A marker from an earlier reply (`id:<n>`), or an ISO date or timestamp. */
  since: string;
  /** A marker that closes the window, to page through an earlier reply's leftovers. */
  until?: string;
  /** Conversations to skip, from a continue line. */
  skip?: number;
  sources?: string[];
  conversationId?: string;
  healthDays?: number;
  maxTokens?: number;
  now?: Date;
  /** Override of WINDOW_IDS for tests. */
  windowIds?: number;
}

export class UpdatesInputError extends Error {}

interface Group {
  source: string;
  source_account: string | null;
  conversation_id: string | null;
  title: string | null;
  count: number;
  first_ts: string | null;
  last_ts: string | null;
}

/** The ids and filters every query of one reply shares. */
interface Window {
  label: string;
  untilId: number;
  /** More was added than one reply covers. */
  capped: boolean;
  /** Filters; `idExpr` is `+id` where a query should stay off the id indexes. */
  where: (idExpr: "id" | "+id") => { sql: string; args: unknown[] };
}

function parseMarker(name: string, value: string): number {
  const marker = MARKER.exec(value.trim());
  if (!marker) throw new UpdatesInputError(`${name} must be a marker such as "id:1234", not "${value}".`);
  return Number(marker[1]);
}

async function resolveWindow(db: QueryExecutor, params: UpdatesParams, now: Date): Promise<Window> {
  // Shaped as a rowid range so the plan names the primary key; it reads one row from the end.
  const latest = (await db.get<{ id: number }>("SELECT id FROM events WHERE id > 0 ORDER BY id DESC LIMIT 1"))?.id ?? 0;
  let untilId = Math.min(params.until === undefined ? latest : parseMarker("until", params.until), latest);
  let capped = false;
  let range: (idExpr: string) => { sql: string[]; args: unknown[] };
  let label: string;

  if (MARKER.test(params.since.trim())) {
    const sinceId = parseMarker("since", params.since);
    if (sinceId > untilId && params.until !== undefined) {
      throw new UpdatesInputError(`until (${params.until}) is before since (${params.since}).`);
    }
    const windowIds = params.windowIds ?? WINDOW_IDS;
    if (untilId - sinceId > windowIds) {
      untilId = sinceId + windowIds;
      capped = true;
    }
    range = (idExpr) => ({ sql: [`${idExpr} > ?`, `${idExpr} <= ?`], args: [sinceId, untilId] });
    label = `added after id:${sinceId}`;
  } else {
    const ms = Date.parse(params.since);
    if (Number.isNaN(ms)) {
      throw new UpdatesInputError(`since must be a marker such as "id:1234" or an ISO date or timestamp, not "${params.since}".`);
    }
    // A page of an earlier reply (until set) keeps that reply's date.
    if (params.until === undefined && ms < now.getTime() - DATE_LOOKBACK_DAYS * DAY_MS) {
      const earliest = new Date(now.getTime() - DATE_LOOKBACK_DAYS * DAY_MS).toISOString();
      throw new UpdatesInputError(`A date since reaches back at most ${DATE_LOOKBACK_DAYS} days; the earliest accepted now is ${earliest}.`);
    }
    const sinceTs = new Date(ms).toISOString();
    const widened = new Date(ms - OFFSET_SLACK_MS).toISOString();
    // `+id`: a bare `id <= ?` reads as a primary key range over the whole table.
    range = () => ({
      sql: ["timestamp >= ?", "julianday(timestamp) >= julianday(?)", "+id <= ?"],
      args: [widened, sinceTs, untilId],
    });
    label = `dated from ${sinceTs}`;
  }

  const filters: string[] = [`source NOT IN (${HEALTH_SOURCES.map(() => "?").join(", ")})`];
  const filterArgs: unknown[] = [...HEALTH_SOURCES];
  const requested = params.sources ?? [];
  if (requested.length > 0) {
    filters.push(`source IN (${requested.map(() => "?").join(", ")})`);
    filterArgs.push(...requested);
  }
  if (params.conversationId !== undefined) {
    filters.push("conversation_id = ?");
    filterArgs.push(params.conversationId);
  }
  const hidden = await hiddenFilter(db);
  if (hidden) filters.push(hidden);

  return {
    label,
    untilId,
    capped,
    where: (idExpr) => {
      const r = range(idExpr);
      return { sql: [...r.sql, ...filters].join(" AND "), args: [...r.args, ...filterArgs] };
    },
  };
}

/**
 * An id that matches nothing would otherwise read as a quiet conversation.
 * Only asked when the window has none of its events; conversation_summaries
 * has a row per titled conversation, and no index on events leads with conversation_id.
 */
async function requireConversation(db: QueryExecutor, conversationId: string): Promise<void> {
  if (await db.get("SELECT 1 FROM conversation_summaries WHERE conversation_id = ? LIMIT 1", conversationId)) return;
  throw new UpdatesInputError(`No conversation has conversation_id "${conversationId}". Pass the conversation_id="…" a heading shows, not a chat name or event_id.`);
}

/** Hidden contacts' events stay out, as on the web app's day view. */
async function hiddenFilter(db: QueryExecutor): Promise<string | null> {
  return await hasHiddenContacts(db) ? `id NOT IN (${hiddenEventIdsSubquery()})` : null;
}

/** A group is shown in full transcript form when it is a social conversation or its source was asked for. */
function isShown(group: Group, requested: Set<string>): boolean {
  if (requested.size === 0 && NOISY_SOURCES.has(group.source)) return false;
  return requested.has(group.source) || (SOCIAL_SOURCES.has(group.source) && group.conversation_id !== null);
}

export async function getUpdates(db: QueryExecutor, params: UpdatesParams): Promise<string> {
  const now = params.now ?? new Date();
  const window = await resolveWindow(db, params, now);
  const maxTokens = params.maxTokens ?? UPDATES_DEFAULT_MAX_TOKENS;
  const requested = new Set(params.sources ?? []);
  const skip = params.skip ?? 0;

  const conversation = conversationTypeClause();
  const all = window.where("id");
  const groups = await db.query<Group>(`
    SELECT source, source_account, CASE WHEN ${conversation} THEN conversation_id END AS conversation_id,
      MAX(title) AS title, COUNT(*) AS count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
    FROM events
    WHERE ${all.sql}
    GROUP BY 1, 2, 3
  `, ...all.args);
  if (params.conversationId !== undefined && groups.length === 0) await requireConversation(db, params.conversationId);
  const shown = groups
    .filter((group) => isShown(group, requested))
    .sort((a, b) => (b.last_ts ?? "").localeCompare(a.last_ts ?? "")
      || a.source.localeCompare(b.source)
      || (a.conversation_id ?? "").localeCompare(b.conversation_id ?? ""));
  const counted = groups.filter((group) => !shown.includes(group));

  const header = [`Updates ${window.label}, up to id:${window.untilId}. Times in UTC.`];
  if (window.capped) header.push(`More was added than one reply covers, so this stops at id:${window.untilId}; the next check continues from there.`);
  const page = skip > 0 || params.until !== undefined;
  const healthDays = params.healthDays ?? (page || params.conversationId !== undefined ? 0 : UPDATES_DEFAULT_HEALTH_DAYS);
  const health = healthSources(params);
  const footer = [
    ...(health.length > 0 && healthDays > 0
      ? await renderHealth(db, health, now, healthDays, window.untilId, Math.floor(maxTokens / 4))
      : []),
    ...renderCounts(page ? [] : counted, requested),
  ];
  const filterArgs = filterArguments(params);
  const nextCheck = `Next check: since="id:${window.untilId}"${filterArgs.map((arg) => `, ${arg}`).join("")}.`;

  const pending = shown.slice(skip);
  const { heading, noun } = sectionHeading(pending, skip);
  // Room for the not-shown list and the continue line; renderLeft names only as many as fit.
  const leftReserve = NAMED_LEFT * 40 + 150;
  const budget = maxTokens - countTokens([...header, heading, ...footer, nextCheck].join("\n")) - leftReserve;
  const { sections, remaining } = await renderSections(db, pending, window, budget, noun);

  const left = pending.slice(sections.length);
  const body = pending.length === 0 ? ["", `No new ${noun}.`] : ["", heading];
  if (sections.length > 0) body.push("", sections.join("\n\n"));
  if (left.length === 0) return [...header, ...body, ...footer, "", nextCheck].join("\n");

  const pageArgs = [
    `since=${JSON.stringify(params.since.trim())}`, `until="id:${window.untilId}"`, `skip=${skip + sections.length}`, ...filterArgs,
    ...(params.maxTokens !== undefined ? [`max_tokens=${params.maxTokens}`] : []),
  ];
  const more = [
    `More conversations: call again with ${pageArgs.join(", ")}. Take the checkpoint from the last page, not this one.`,
    "(Paging gets more conversations; export_conversation gets earlier messages of one already shown.)",
  ];
  body.push("", ...renderLeft(left, leftReserve + remaining - countTokens(more.join("\n"))));
  return [...header, ...body, ...footer, "", ...more].join("\n");
}

/** As many pending conversations as fit `budget` tokens, in order; one too long even alone becomes a pointer. */
async function renderSections(
  db: QueryExecutor,
  pending: Group[],
  window: Window,
  start: number,
  noun: string,
): Promise<{ sections: string[]; remaining: number }> {
  let budget = start;
  const sections: string[] = [];
  for (const [index, group] of pending.entries()) {
    if (index >= GROUP_LIMIT) break;
    const fairShare = Math.floor(budget / (Math.min(pending.length, GROUP_LIMIT) - index) / 20);
    const limit = Math.min(group.count, GROUP_MESSAGE_LIMIT, Math.max(GROUP_MESSAGE_MIN, fairShare));
    const rendered = budget > 0 ? await renderGroup(db, group, window, limit, budget, noun) : null;
    if (rendered) {
      sections.push(rendered.text);
      budget -= rendered.tokens;
      continue;
    }
    if (sections.length > 0) break;
    // Too long even alone: point to it, so the next page moves past it.
    const pointer = `## ${groupLabel(group)}\n${group.count} new, too long for max_tokens; read them with ${restPointer(group)}.`;
    sections.push(pointer);
    budget -= countTokens(pointer) + 2;
    break;
  }
  return { sections, remaining: budget };
}

/** The filters a follow-up call must repeat, as arguments. */
function filterArguments(params: UpdatesParams): string[] {
  const args: string[] = [];
  if (params.sources?.length) args.push(`sources=${JSON.stringify(params.sources)}`);
  if (params.conversationId !== undefined) args.push(`conversation_id=${JSON.stringify(params.conversationId)}`);
  return args;
}

/** "Messages" only when every group is a conversation of messages; recordings and other listed sources are events. */
function sectionHeading(pending: Group[], skip: number): { heading: string; noun: string } {
  const messages = pending.every((group) => SOCIAL_SOURCES.has(group.source) && group.conversation_id !== null);
  const count = pending.reduce((sum, group) => sum + group.count, 0);
  const groups = plural(pending.length, messages ? "conversation" : "group");
  const after = skip > 0 ? `, after the first ${skip}` : "";
  return {
    heading: `# ${messages ? "Messages" : "Events"}: ${count} new in ${groups}, most recent first${after}`,
    noun: messages ? "messages" : "events",
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Listed sources narrow health to the health sources among them. */
function healthSources(params: UpdatesParams): string[] {
  const requested = params.sources ?? [];
  return HEALTH_SOURCES.filter((source) => requested.length === 0 || requested.includes(source));
}

/** The not-shown list within `budget` tokens: as many named conversations as fit, then a sum of the rest. */
function renderLeft(left: Group[], budget: number): string[] {
  const heading = `Not shown, over the size cap (${left.length}):`;
  let used = countTokens(heading) + 40;
  const named: string[] = [];
  for (const group of left.slice(0, NAMED_LEFT)) {
    const line = `- ${groupLabel(group)}: ${group.count} new, last ${group.last_ts ?? "undated"}`;
    used += countTokens(line) + 1;
    if (used > budget) break;
    named.push(line);
  }
  const rest = left.slice(named.length);
  if (rest.length > 0) named.push(`- ${named.length > 0 ? "and " : ""}${rest.length} more conversations, ${rest.reduce((sum, group) => sum + group.count, 0)} new messages`);
  return [heading, ...named];
}

function restPointer(group: Group): string {
  return group.conversation_id === null
    ? `query_events with source "${group.source}"`
    : `export_conversation conversation_id="${group.conversation_id}" start_date="${group.first_ts}"`;
}

function shortTitle(title: string | null): string {
  if (!title) return "(untitled)";
  return title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title;
}

function groupLabel(group: Group): string {
  return group.conversation_id === null
    ? `${group.source}, not in a conversation`
    : `${group.source}: ${shortTitle(group.title)} · conversation_id=${JSON.stringify(group.conversation_id)}`;
}

/** The newest `limit` events of a group, cut further until it fits the budget, or null when even the minimum does not. */
async function renderGroup(
  db: QueryExecutor,
  group: Group,
  window: Window,
  limit: number,
  budget: number,
  noun: string,
): Promise<{ text: string; tokens: number } | null> {
  const conversation = conversationTypeClause();
  // A conversation reads its own index entries (`+id` keeps the planner off
  // the source's whole id range); other groups read their source's id range.
  const filter = window.where(group.conversation_id === null ? "id" : "+id");
  const groupWhere = group.conversation_id === null
    ? `source = ? AND source_account IS ? AND (conversation_id IS NULL OR NOT ${conversation})`
    : `source = ? AND source_account IS ? AND conversation_id = ? AND ${conversation}`;
  const groupArgs = group.conversation_id === null
    ? [group.source, group.source_account]
    : [group.source, group.source_account, group.conversation_id];
  const newest = await db.query<TimelineEvent>(`
    SELECT * FROM events
    WHERE ${groupWhere} AND ${filter.sql}
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `, ...groupArgs, ...filter.args, limit);

  for (let take = newest.length; take > 0 && take >= Math.min(GROUP_MESSAGE_MIN, newest.length); take = Math.floor(take / 2)) {
    const events = newest.slice(0, take).reverse();
    // Events outside a conversation render as several titled groups, so they take full timestamps instead of date headers.
    const loose = group.conversation_id === null;
    const transcript = await renderExportText(db, events, {
      compactAuthors: true, noSummaries: true, fullTimestamps: loose, omitHiddenReplyAuthors: true,
    });
    const rest = loose
      ? transcript.split("\n").map((line) => line.replace(/^## [^:]*: /, "### "))
      : transcript.split("\n").slice(1);
    const lines = [`## ${groupLabel(group)} · latest event_id=${events[events.length - 1]?.id}`];
    if (take < group.count) {
      const exportNote = group.conversation_id === null ? "" : " (newest 500 by default; raise limit or set end_date for earlier ones)";
      lines.push(`Showing the latest ${take} of ${group.count} new ${noun}; for more, ${restPointer(group)}${exportNote}.`);
    }
    const text = [...lines, ...rest].join("\n");
    const tokens = countTokens(text) + 2;
    if (tokens <= budget) return { text, tokens };
  }
  return null;
}

/** One line per day, newest days kept when over `budget` tokens, in the source's own calendar days. */
async function renderHealth(db: QueryExecutor, sources: string[], now: Date, days: number, untilId: number, budget: number): Promise<string[]> {
  // Today and the days - 1 before it.
  const from = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  // A day earlier, for the night that ends on the first day.
  const queryFrom = new Date(Date.parse(from) - DAY_MS).toISOString().slice(0, 10);
  const hidden = await hiddenFilter(db);
  const rows = await db.query<Pick<TimelineEvent, "source" | "type" | "timestamp" | "end_timestamp" | "title">>(`
    SELECT source, type, timestamp, end_timestamp, title FROM events
    WHERE source IN (${sources.map(() => "?").join(", ")}) AND timestamp >= ? AND +id <= ?
      AND (type = 'sleep' OR type LIKE 'daily:%')${hidden ? ` AND ${hidden}` : ""}
    ORDER BY timestamp
  `, ...sources, queryFrom, untilId);

  const rank = (source: string) => HEALTH_SOURCES.indexOf(source as typeof HEALTH_SOURCES[number]);
  // day -> type -> { source, titles }
  const byDay = new Map<string, Map<string, { source: string; titles: string[] }>>();
  for (const row of rows) {
    // A night's sleep counts for the day it ends.
    const day = (row.type === "sleep" ? row.end_timestamp ?? row.timestamp : row.timestamp)?.slice(0, 10);
    if (!day || day < from || day > today || !row.title) continue;
    let types = byDay.get(day);
    if (!types) {
      types = new Map();
      byDay.set(day, types);
    }
    const existing = types.get(row.type);
    if (!existing || rank(row.source) < rank(existing.source)) {
      types.set(row.type, { source: row.source, titles: [row.title] });
    } else if (existing.source === row.source) {
      existing.titles.push(row.title);
    }
  }
  if (byDay.size === 0) return ["", `# Health, last ${days} days: no records.`];

  const order = (type: string) => {
    const index = HEALTH_TYPE_ORDER.indexOf(type);
    return index === -1 ? HEALTH_TYPE_ORDER.length : index;
  };
  const lines = [...byDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, types]) => `${day}: ${[...types.entries()]
      .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
      .flatMap(([, entry]) => entry.titles)
      .join(" · ")}`);
  const heading = `# Health, last ${days} days (repeated on every broad check; days are the device's local days)`;
  let used = countTokens(heading) + 20;
  const kept: string[] = [];
  for (const line of lines) {
    used += countTokens(line) + 1;
    if (used > budget) break;
    kept.push(line);
  }
  const cut = kept.length < lines.length ? [`(${lines.length - kept.length} older days cut to fit; pass a larger max_tokens)`] : [];
  return ["", heading, ...kept.reverse(), ...cut];
}

function renderCounts(counted: Group[], requested: Set<string>): string[] {
  const bySource = new Map<string, number>();
  for (const group of counted) bySource.set(group.source, (bySource.get(group.source) ?? 0) + group.count);
  if (bySource.size === 0) return [];
  const entries = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
  const other = entries.filter(([source]) => requested.size > 0 || !NOISY_SOURCES.has(source));
  const noisy = entries.filter(([source]) => requested.size === 0 && NOISY_SOURCES.has(source));
  const lines: string[] = [];
  if (other.length > 0) {
    lines.push("", "# Other new events, counted not shown (pass sources to see one, or use query_events)");
    lines.push(other.map(([source, count]) => `${source} ${count}`).join(", "));
  }
  if (noisy.length > 0) {
    lines.push("", `Left out as noisy unless listed in sources: ${noisy.map(([source, count]) => `${source} ${count}`).join(", ")}`);
  }
  return lines;
}

export const GET_UPDATES_DESCRIPTION = `What was added to Timeline since you last checked: new messages by conversation, recent daily health lines, and a count per source of other new events. Pass the checkpoint the reply ends with as since next time; it catches old events imported late. A date since starts at midnight UTC; for local midnight pass T00:00 with your offset. Edits to existing events are not new.`;

export const GET_UPDATES_SCHEMA = {
  since: z.string().min(1).describe(`Checkpoint from the last reply ("id:1234"), or an ISO date or timestamp at most ${DATE_LOOKBACK_DAYS} days back`),
  until: z.string().optional().describe("From a continue line"),
  skip: z.number().int().min(0).optional().describe("From a continue line"),
  sources: z.array(z.string().min(1)).min(1).optional().describe("Only these sources, shown in full; noisy ones are left out unless listed"),
  conversation_id: z.string().min(1).optional().describe("Only this conversation, as a heading shows it"),
  health_days: z.number().int().min(0).max(90).optional().describe(`Days of health lines up to today; default ${UPDATES_DEFAULT_HEALTH_DAYS}, or 0 with skip, until or conversation_id`),
  max_tokens: z.number().int().min(1000).max(50000).optional().describe(`Approximate reply size cap, default ${UPDATES_DEFAULT_MAX_TOKENS}`),
};

export async function runGetUpdates(
  db: QueryExecutor,
  params: { since: string; until?: string; skip?: number; sources?: string[]; conversation_id?: string; health_days?: number; max_tokens?: number },
): Promise<CallToolResult> {
  try {
    const text = await getUpdates(db, {
      since: params.since,
      until: params.until,
      skip: params.skip,
      sources: params.sources,
      conversationId: params.conversation_id,
      healthDays: params.health_days,
      maxTokens: params.max_tokens,
    });
    return { content: [{ type: "text" as const, text }] };
  } catch (error) {
    if (!(error instanceof UpdatesInputError)) throw error;
    return { isError: true, content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
  }
}
