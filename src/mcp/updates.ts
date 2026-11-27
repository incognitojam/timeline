/**
 * get_updates: what was added to Timeline since a marker, in one compact reply.
 *
 * "New" means added to Timeline, not dated recently: syncs and exports bring
 * in events long after they happen. events.id is AUTOINCREMENT, so ids only
 * grow and are never reused; a marker is the highest id the reply covered, and
 * the next call asks for ids above it.
 *
 * A checkpoint is a caller's name for a marker kept in app-state.db. The last
 * page of an unfiltered catch-up moves it, and only when that catch-up started
 * at or before where it stood, so it never passes an event no reply covered.
 * A reply from a checkpoint names where its last few moves started, so a reply
 * lost in transit, or two in a row, can be asked for again.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { conversationTypeClause } from "../db/conversation-types";
import { hasHiddenContacts, hiddenEventIdsSubquery } from "../db/events";
import { formatIdentifier, resolveIdentities } from "../db/identities";
import type { QueryExecutor } from "../db/pool";
import type { Database } from "../db/sqlite";
import type { TimelineEvent } from "../db/schema";
import { renderExportText } from "../export/export";
import { countTokens } from "../export/tokens";
import { HIDDEN_CONTACT_NAME } from "./hidden-contacts";
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
const PHONE_SOURCES = new Set(sourceIdsWithTraits((traits) => traits.phoneIdentity === true));
/** Few events, each worth reading: one line apiece instead of a count. No source trait says this. */
const LISTED_SOURCES = ["google-calendar", "call-recordings", "trakt", "swarm"];
const LISTED_TYPES = ["location:visit"];
const LISTED_SQL = `(source IN (${LISTED_SOURCES.map(() => "?").join(", ")}) OR type IN (${LISTED_TYPES.map(() => "?").join(", ")}))`;
/** Most one-line events a reply lists. */
const LISTED_LIMIT = 30;
/** Longest text a one-line event shows. */
const LINE_CHARS = 120;
/** Most messages one conversation shows; the rest are pointed to. */
const GROUP_MESSAGE_LIMIT = 100;
/** Fewest messages a conversation is cut to before the reply stops. */
const GROUP_MESSAGE_MIN = 5;
/** Most conversations one reply shows. */
const GROUP_LIMIT = 40;
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
const SINCE_CHARS = 64;
const CHECKPOINT_NAME_CHARS = 40;
const CHECKPOINT_NAME = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${CHECKPOINT_NAME_CHARS - 1}}$`);
/** A checkpoint no call has used for this long is deleted when another is created or moved. */
export const CHECKPOINT_IDLE_DAYS = 90;
/** Moves a checkpoint remembers, so a retry can reach back past more than one lost reply. */
const MOVES_KEPT = 3;
/** Where a new checkpoint's first catch-up starts. */
const NEW_CHECKPOINT_DAYS = 7;
const MAX_TOKENS_MIN = 1000;
const MAX_TOKENS_MAX = 50000;

export const UPDATES_DEFAULT_MAX_TOKENS = 8000;
export const UPDATES_DEFAULT_HEALTH_DAYS = 14;

export interface UpdatesParams {
  /** A marker from an earlier reply (`id:<n>`), or an ISO date or timestamp. */
  since?: string;
  /** A name whose position Timeline keeps; without since, the catch-up starts there. */
  checkpoint?: string;
  /** From an earlier page; carries everything but max_tokens and health_days. */
  cursor?: string;
  sources?: string[];
  conversationId?: string;
  healthDays?: number;
  maxTokens?: number;
  now?: Date;
  /** Override of WINDOW_IDS for tests. */
  windowIds?: number;
}

/** The app-state database that keeps checkpoints, opened on first use. */
export type CheckpointStore = () => Database;

/** What one page asks for, once a cursor or checkpoint is resolved. */
const PageSchema = z.object({
  since: z.string().min(1),
  /** The id the catch-up stops at, fixed by its first page. */
  until: z.number().int().min(0).optional(),
  /** Conversations earlier pages showed. */
  skip: z.number().int().min(0).default(0),
  /** A checksum of the first page's groups in order, to notice the catch-up changing under the cursor. */
  order: z.string().optional(),
  checkpoint: z.string().regex(CHECKPOINT_NAME).optional(),
  sources: z.array(z.string().min(1)).min(1).optional(),
  conversationId: z.string().min(1).optional(),
  maxTokens: z.number().int().min(MAX_TOKENS_MIN).max(MAX_TOKENS_MAX).optional(),
}).strict();
type Page = z.infer<typeof PageSchema>;

interface Checkpoint {
  position: number;
  /** Where the catch-ups that moved it started, oldest first. */
  moves: { from: string; at: string }[];
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
  /** 1 when its source or type is listed one line per event. */
  listed: number;
  /** 1 when the owner sent one of its events, or it is a direct conversation with them. */
  mine: number;
}

/** The ids and filters every query of one reply shares. */
interface Window {
  label: string;
  /** since as "id:<n>" or an ISO timestamp, never the caller's own text. */
  since: string;
  /** The marker since was, or null for a date. */
  sinceId: number | null;
  untilId: number;
  /** The newest event's id when the page was made. */
  latest: number;
  /** More was added than one reply covers. */
  capped: boolean;
  /** Events dated before this are old imports, summed rather than shown; set for a marker since. */
  oldBefore: string | null;
  /** Filters, for the events dated after oldBefore unless `old`; `idExpr` is `+id` where a query should stay off the id indexes. */
  where: (idExpr: "id" | "+id", old?: boolean) => { sql: string; args: unknown[] };
}

/** The page a call asks for, and a line on where its checkpoint starts. */
function resolvePage(params: UpdatesParams, store: CheckpointStore | undefined, now: Date): { page: Page; note: string[] } {
  if (params.cursor !== undefined) {
    if ([params.since, params.checkpoint, params.sources, params.conversationId].some((value) => value !== undefined)) {
      throw new UpdatesInputError("Pass cursor alone (max_tokens may change): it already carries since, checkpoint and the filters.");
    }
    const page = decodeCursor(params.cursor);
    return { page: { ...page, maxTokens: params.maxTokens ?? page.maxTokens }, note: [] };
  }
  const { checkpoint: name, since, sources, conversationId, maxTokens } = params;
  const page = { skip: 0, checkpoint: name, sources, conversationId, maxTokens };
  if (name === undefined) {
    if (since === undefined) throw new UpdatesInputError('Pass checkpoint="<a name of yours>" to catch up from where that name left off, or since.');
    return { page: { ...page, since }, note: [] };
  }
  const db = requireStore(store)();
  const stored = readCheckpoint(db, checkpointName(name));
  if (!stored) {
    const names = (db.query("SELECT name FROM mcp_checkpoints ORDER BY used_at DESC, name LIMIT 10").all() as { name: string }[]).map((row) => row.name);
    const existing = names.length > 0 ? ` Existing checkpoints, most recently used first: ${names.join(", ")}.` : "";
    if (since !== undefined) return { page: { ...page, since }, note: [`Checkpoint "${name}" is new.${existing}`] };
    const start = new Date(now.getTime() - NEW_CHECKPOINT_DAYS * DAY_MS).toISOString();
    return { page: { ...page, since: start }, note: [`Checkpoint "${name}" is new, so this starts ${NEW_CHECKPOINT_DAYS} days back; pass since to start elsewhere.${existing}`] };
  }
  // Using a checkpoint keeps it from being cleaned up.
  db.query("UPDATE mcp_checkpoints SET used_at = ? WHERE name = ?").run(now.toISOString(), name);
  const moves = stored.moves.map((move) => `since=${JSON.stringify(move.from)} (${move.at.slice(0, 16)}Z)`).join(", ");
  return {
    page: { ...page, since: since ?? `id:${stored.position}` },
    note: [`Checkpoint "${name}" is at id:${stored.position}. The catch-ups that last moved it started at ${moves}. If replies you asked for were lost, call again with checkpoint="${name}" and the since of the earliest lost one; that repeats what came after it.`],
  };
}

/** A cursor is the page as JSON with a short checksum, so a mistyped one is refused rather than skipping conversations. */
function encodeCursor(page: Page): string {
  const payload = Buffer.from(JSON.stringify(page)).toString("base64url");
  return `${payload}.${checksum(payload)}`;
}

function decodeCursor(cursor: string): Page {
  const [payload = "", sum, ...rest] = cursor.split(".");
  try {
    if (rest.length > 0 || sum !== checksum(payload)) throw new Error("checksum");
    return PageSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
  } catch {
    throw new UpdatesInputError("cursor is not one this tool printed; pass it exactly as the More line gives it.");
  }
}

function checksum(payload: string): string {
  return createHash("sha256").update(payload).digest("base64url").slice(0, 8);
}

function checkpointName(name: string): string {
  if (!CHECKPOINT_NAME.test(name)) {
    throw new UpdatesInputError(`checkpoint must be 1-${CHECKPOINT_NAME_CHARS} letters, digits, ".", "_" or "-", starting with a letter or digit, not ${JSON.stringify(name)}.`);
  }
  return name;
}

function requireStore(store: CheckpointStore | undefined): CheckpointStore {
  if (!store) throw new Error("get_updates was called with a checkpoint but no app-state database");
  return store;
}

function readCheckpoint(db: Database, name: string): Checkpoint | null {
  const row = db.query("SELECT position, moves FROM mcp_checkpoints WHERE name = ?").get(name) as { position: number; moves: string } | null;
  return row && { position: row.position, moves: JSON.parse(row.moves) };
}

/**
 * Moves a checkpoint to where a catch-up ended, and returns where it stands. A
 * catch-up that started after it, or by date, may have left events out, so it
 * leaves an existing checkpoint alone; so does one that ends at or before it.
 * A move also deletes checkpoints idle for CHECKPOINT_IDLE_DAYS.
 */
function moveCheckpoint(db: Database, name: string, window: Window, now: Date): number {
  return db.transaction(() => {
    const stored = readCheckpoint(db, name);
    if (stored && (window.sinceId === null || window.sinceId > stored.position || window.untilId <= stored.position)) return stored.position;
    const moves = [...(stored?.moves ?? []), { from: window.since, at: now.toISOString() }].slice(-MOVES_KEPT);
    db.query(`
      INSERT INTO mcp_checkpoints (name, position, moves, used_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET position = excluded.position, moves = excluded.moves, used_at = excluded.used_at
    `).run(name, window.untilId, JSON.stringify(moves), now.toISOString());
    db.query("DELETE FROM mcp_checkpoints WHERE used_at < ?").run(new Date(now.getTime() - CHECKPOINT_IDLE_DAYS * DAY_MS).toISOString());
    return window.untilId;
  }).immediate();
}

async function resolveWindow(db: QueryExecutor, params: Page, now: Date, windowIdsOverride?: number): Promise<Window> {
  // Shaped as a rowid range so the plan names the primary key; it reads one row from the end.
  const latest = (await db.get<{ id: number }>("SELECT id FROM events WHERE id > 0 ORDER BY id DESC LIMIT 1"))?.id ?? 0;
  let untilId = Math.min(params.until ?? latest, latest);
  let capped = false;
  let sinceId: number | null = null;
  let oldBefore: string | null = null;
  let range: (idExpr: string) => { sql: string[]; args: unknown[] };
  let label: string;
  let since: string;

  // Longer than any marker or timestamp; Date.parse would accept text in parentheses.
  if (params.since.length > SINCE_CHARS) throw new UpdatesInputError(`since must be a marker such as "id:1234" or an ISO date or timestamp, at most ${SINCE_CHARS} characters.`);
  const marker = MARKER.exec(params.since.trim());
  if (marker) {
    sinceId = Number(marker[1]);
    const windowIds = windowIdsOverride ?? WINDOW_IDS;
    if (untilId - sinceId > windowIds) {
      untilId = sinceId + windowIds;
      capped = true;
    }
    const from = sinceId;
    range = (idExpr) => ({ sql: [`${idExpr} > ?`, `${idExpr} <= ?`], args: [from, untilId] });
    label = `added after id:${sinceId}`;
    since = `id:${sinceId}`;
    // Ids follow insertion, so an export of years ago arrives as new: events dated
    // further before the marker was added than a date since may reach are old.
    const added = (await db.get<{ imported_at: string }>("SELECT imported_at FROM events WHERE id <= ? AND id > 0 ORDER BY id DESC LIMIT 1", sinceId))?.imported_at;
    if (added) oldBefore = new Date(Date.parse(`${added.replace(" ", "T")}Z`) - DATE_LOOKBACK_DAYS * DAY_MS).toISOString();
  } else {
    const ms = Date.parse(params.since);
    if (Number.isNaN(ms)) {
      throw new UpdatesInputError(`since must be a marker such as "id:1234" or an ISO date or timestamp, not "${params.since}".`);
    }
    // A later page (until set) keeps its first page's date.
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
    since = sinceTs;
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
    since,
    sinceId,
    untilId,
    latest,
    capped,
    oldBefore,
    where: (idExpr, old = false) => {
      const r = range(idExpr);
      // One shape whether or not oldBefore is set, `+` keeping it off the timestamp index.
      const age = old ? "+timestamp < ?" : "(+timestamp IS NULL OR +timestamp >= ?)";
      return { sql: [...r.sql, age, ...filters].join(" AND "), args: [...r.args, oldBefore ?? "", ...filterArgs] };
    },
  };
}

/**
 * An id that matches nothing would otherwise read as a quiet conversation.
 * Only asked when the window has none of its events. No index leads with
 * conversation_id, so this skip-scans idx_events_conversation_id: one seek per
 * source and account, then one probe each. conversation_summaries would be one
 * query, but it leaves out conversations without a title.
 */
async function requireConversation(db: QueryExecutor, conversationId: string): Promise<void> {
  const conversation = `conversation_id IS NOT NULL AND ${conversationTypeClause()}`;
  // A conversation with only hidden contacts' events reads as missing, as in export_conversation.
  const hidden = await hiddenFilter(db);
  const next = async (sql: string, ...args: unknown[]) => (await db.get<{ next: string | null }>(sql, ...args))?.next ?? null;
  const probe = async (source: string, account: string | null) => await db.get(
    `SELECT 1 FROM events WHERE source = ? AND source_account IS ? AND conversation_id = ? AND ${conversation}${hidden ? ` AND ${hidden}` : ""} LIMIT 1`,
    source, account, conversationId,
  );
  for (
    let source = await next(`SELECT MIN(source) AS next FROM events WHERE ${conversation}`);
    source !== null;
    source = await next(`SELECT MIN(source) AS next FROM events WHERE source > ? AND ${conversation}`, source)
  ) {
    if (await probe(source, null)) return;
    for (
      let account = await next(`SELECT MIN(source_account) AS next FROM events WHERE source = ? AND source_account IS NOT NULL AND ${conversation}`, source);
      account !== null;
      account = await next(`SELECT MIN(source_account) AS next FROM events WHERE source = ? AND source_account > ? AND ${conversation}`, source, account)
    ) {
      if (await probe(source, account)) return;
    }
  }
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

export async function getUpdates(db: QueryExecutor, params: UpdatesParams, store?: CheckpointStore): Promise<string> {
  const now = params.now ?? new Date();
  const { page: request, note } = resolvePage(params, store, now);
  const window = await resolveWindow(db, request, now, params.windowIds);
  const maxTokens = request.maxTokens ?? UPDATES_DEFAULT_MAX_TOKENS;
  const requested = new Set(request.sources ?? []);
  const skip = request.skip;

  const groups = await loadGroups(db, window, requested);
  if (request.conversationId !== undefined && groups.length === 0) await requireConversation(db, request.conversationId);
  // Conversations that involve the owner first, then the newest.
  const shown = groups
    .filter((group) => !group.listed && isShown(group, requested))
    .sort((a, b) => b.mine - a.mine
      || (b.last_ts ?? "").localeCompare(a.last_ts ?? "")
      || a.source.localeCompare(b.source)
      || (a.conversation_id ?? "").localeCompare(b.conversation_id ?? ""));
  await nameHandles(db, shown);
  const later = request.until !== undefined;
  const oneLine = groups.filter((group) => group.listed);
  const counted = groups.filter((group) => !group.listed && !shown.includes(group));

  const of = request.checkpoint === undefined ? "" : ` for checkpoint "${request.checkpoint}"`;
  const header = [`Updates${of} ${window.label}, up to id:${window.untilId}. Times in UTC.`, ...note];
  if (window.capped) header.push(`More was added than one reply covers, so this stops at id:${window.untilId}; the next check continues from there.`);
  const healthDays = params.healthDays ?? defaultHealthDays(request);
  const health = healthSources(request);
  const footer = [
    ...(health.length > 0 && healthDays > 0
      ? await renderHealth(db, health, now, healthDays, window.untilId, Math.floor(maxTokens / 4))
      : []),
    ...renderCounts(later ? [] : counted, requested, new Set(oneLine.map((group) => group.source))),
    ...(later ? [] : await renderOld(db, window, Math.floor(maxTokens / 8))),
  ];

  const order = checksum(shown.map((group) => `${group.source}\t${group.source_account}\t${group.conversation_id}`).join("\n"));
  if (request.order !== undefined && request.order !== order) {
    throw new UpdatesInputError("This catch-up changed since its first page (a contact was hidden, shown or linked). Start it again without the cursor.");
  }
  const pending = shown.slice(skip);
  const { heading, noun } = sectionHeading(pending, skip);
  const listing = [
    ...(pending.length === 0 ? [`No new ${noun}.`] : [heading, ...renderIndex(pending, Math.floor(maxTokens / 2), noun)]),
    ...(later ? [] : await renderListed(db, window, oneLine, Math.floor(maxTokens / 6), window.since)),
  ];
  // Room for the last line.
  const budget = maxTokens - countTokens([...header, ...listing, ...footer].join("\n")) - 200;
  const { sections } = await renderSections(db, pending, window, budget, noun);

  const body = ["", ...listing];
  if (sections.length > 0) body.push("", sections.join("\n\n"));
  if (pending.length === sections.length) return [...header, ...body, ...footer, "", nextCheckLine(request, window, store, now)].join("\n");

  const cursor = encodeCursor({ ...request, until: window.untilId, skip: skip + sections.length, order });
  const more = [
    "(Paging gets the conversations not shown in full; export_conversation gets earlier messages of one already shown.)",
    `More: call again with cursor="${cursor}".`,
  ];
  return [...header, ...body, ...footer, "", ...more].join("\n");
}

/** The window's events by source, account and conversation, with whether each group is listed and involves the owner. */
async function loadGroups(db: QueryExecutor, window: Window, requested: Set<string>): Promise<Group[]> {
  const conversation = conversationTypeClause();
  const all = window.where("id");
  const mine = await selfIdentifiers(db);
  // Listing a source shows it in full, so listed events only stand apart in a broad check.
  const listed = requested.size === 0 ? { sql: LISTED_SQL, args: [...LISTED_SOURCES, ...LISTED_TYPES] } : { sql: "0", args: [] };
  return await db.query<Group>(`
    SELECT source, source_account, CASE WHEN ${conversation} THEN conversation_id END AS conversation_id,
      CASE WHEN ${conversation} THEN 0 ELSE ${listed.sql} END AS listed,
      MAX(title) AS title, COUNT(*) AS count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts,
      MAX(json_extract(people, '$[0]') IN (SELECT value FROM json_each(?)) OR type LIKE 'message:dm%'
        OR (json_array_length(people) <= 2 AND EXISTS (SELECT 1 FROM json_each(people) WHERE value IN (SELECT value FROM json_each(?))))) AS mine
    FROM events
    WHERE ${all.sql}
    GROUP BY 1, 2, 3, 4
  `, ...listed.args, JSON.stringify(mine), JSON.stringify(mine), ...all.args);
}

/** The owner's identifiers, as events' people name them. */
async function selfIdentifiers(db: QueryExecutor): Promise<string[]> {
  const rows = await db.query<{ platform: string; platform_id: string }>(
    "SELECT platform, platform_id FROM identities WHERE contact_id = (SELECT id FROM contacts WHERE is_self = 1)",
  );
  return rows.map((row) => formatIdentifier(row.platform, row.platform_id));
}

/** A conversation titled by a phone number gets its contact's name beside it, where Timeline knows one. */
async function nameHandles(db: QueryExecutor, groups: Group[]): Promise<void> {
  const numbered = groups.filter((group) => PHONE_SOURCES.has(group.source) && /^\+?\d{6,}$/.test(group.title ?? ""));
  if (numbered.length === 0) return;
  const identities = await resolveIdentities(db, numbered.map((group) => `phone:${group.title}`));
  for (const group of numbered) {
    const identity = identities[`phone:${group.title}`];
    if (identity?.name && !identity.hidden) group.title = `${identity.name} (${group.title})`;
  }
}

/** One line per conversation still to show, within `budget` tokens, so a reply cut short still names them. */
function renderIndex(pending: Group[], budget: number, noun: string): string[] {
  const lines: string[] = [];
  let used = 20;
  for (const group of pending) {
    const line = `- ${groupLabel(group)} · ${group.count} new`;
    used += countTokens(line) + 1;
    if (used > budget) break;
    lines.push(line);
  }
  const rest = pending.slice(lines.length);
  if (rest.length > 0) lines.push(`- and ${plural(rest.length, noun === "messages" ? "more conversation" : "more group")}, ${rest.reduce((sum, group) => sum + group.count, 0)} new`);
  return lines;
}

/** Listed sources' events, one line each, newest first, within `budget` tokens. */
async function renderListed(db: QueryExecutor, window: Window, groups: Group[], budget: number, since: string): Promise<string[]> {
  if (groups.length === 0) return [];
  const filter = window.where("id");
  const rows = await db.query<Pick<TimelineEvent, "source" | "type" | "timestamp" | "title" | "content" | "location_name">>(`
    SELECT source, type, timestamp, title, content, location_name FROM events
    WHERE ${LISTED_SQL} AND (conversation_id IS NULL OR NOT ${conversationTypeClause()}) AND ${filter.sql}
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `, ...LISTED_SOURCES, ...LISTED_TYPES, ...filter.args, LISTED_LIMIT);
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const lines: string[] = [];
  let used = 40;
  for (const row of rows) {
    const what = row.title ?? row.content ?? row.type;
    const where = row.location_name && !what.includes(row.location_name) ? ` @ ${row.location_name}` : "";
    const text = `${what}${where}`.replace(/\s+/g, " ");
    const line = `- ${row.timestamp?.slice(0, 16).replace("T", " ") ?? "undated"} ${row.source}: ${text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text}`;
    used += countTokens(line) + 1;
    if (used > budget) break;
    lines.push(line);
  }
  const sources = [...new Set(groups.map((group) => group.source))];
  if (total > lines.length) lines.push(`- and ${total - lines.length} more; get_updates with since=${JSON.stringify(since)}, sources=${JSON.stringify(sources)} lists every event of these sources, those above included`);
  return ["", `# Events, one line each (${total})`, ...lines];
}

/**
 * Old events imported in this window, one line per source within `budget` tokens.
 * When the marker's event was added stands in for when the caller last checked;
 * since="id:0" has no such event, so nothing is old.
 */
async function renderOld(db: QueryExecutor, window: Window, budget: number): Promise<string[]> {
  if (window.oldBefore === null) return [];
  const filter = window.where("id", true);
  const rows = await db.query<{ source: string; count: number; first_ts: string; last_ts: string }>(`
    SELECT source, COUNT(*) AS count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
    FROM events WHERE ${filter.sql}
    GROUP BY source ORDER BY count DESC
  `, ...filter.args);
  if (rows.length === 0) return [];
  const heading = `# Imported but dated before ${window.oldBefore.slice(0, 10)}, not listed (query_events with source and end_date reads them)`;
  const lines: string[] = [];
  let used = countTokens(heading) + 30;
  for (const row of rows) {
    const line = `${row.source} ${row.count}, dated ${row.first_ts.slice(0, 10)} to ${row.last_ts.slice(0, 10)}`;
    used += countTokens(line) + 1;
    if (used > budget) break;
    lines.push(line);
  }
  const rest = rows.slice(lines.length);
  if (rest.length > 0) lines.push(`and ${plural(rest.length, "more source")}, ${rest.reduce((sum, row) => sum + row.count, 0)} events`);
  return ["", heading, ...lines];
}

/** A catch-up without filters, the only kind that moves a checkpoint. */
function isBroad(request: Page): boolean {
  return request.sources === undefined && request.conversationId === undefined;
}

/** The last page's one next action, moving its checkpoint first. */
function nextCheckLine(request: Page, window: Window, store: CheckpointStore | undefined, now: Date): string {
  const name = request.checkpoint;
  const waiting = window.untilId < window.latest ? "More is waiting: call again now with" : "Next check:";
  const since = [`since="id:${window.untilId}"`];
  if (request.sources) since.push(`sources=${JSON.stringify(request.sources)}`);
  if (request.conversationId !== undefined) since.push(`conversation_id=${JSON.stringify(request.conversationId)}`);
  if (name === undefined) return `${waiting} ${since.join(", ")}.`;
  if (!isBroad(request)) return `${waiting} ${since.join(", ")} (checkpoint "${name}" was not moved: only a catch-up without sources or conversation_id moves it).`;
  const position = moveCheckpoint(requireStore(store)(), name, window, now);
  const where = position === window.untilId
    ? `Checkpoint "${name}" is now at id:${position}.`
    : `Checkpoint "${name}" stays at id:${position}: a catch-up moves it only when it starts by id at or before it.`;
  return `${where} ${waiting} checkpoint="${name}".`;
}

/** As many pending conversations as fit `budget` tokens, in order; one too long even alone becomes a pointer. */
async function renderSections(
  db: QueryExecutor,
  pending: Group[],
  window: Window,
  start: number,
  noun: string,
): Promise<{ sections: string[] }> {
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
  return { sections };
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

/** Health shows on a broad first page; later pages and one conversation leave it out. */
function defaultHealthDays(request: Page): number {
  return request.until !== undefined || request.conversationId !== undefined ? 0 : UPDATES_DEFAULT_HEALTH_DAYS;
}

/** Listed sources narrow health to the health sources among them. */
function healthSources(params: Page): string[] {
  const requested = params.sources ?? [];
  return HEALTH_SOURCES.filter((source) => requested.length === 0 || requested.includes(source));
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
      compactAuthors: true, noSummaries: true, fullTimestamps: loose, hiddenContactName: HIDDEN_CONTACT_NAME,
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

/** Counts by source; a source with some events listed one line each is counted as its "other" events. */
function renderCounts(counted: Group[], requested: Set<string>, listed: Set<string>): string[] {
  const bySource = new Map<string, number>();
  for (const group of counted) bySource.set(group.source, (bySource.get(group.source) ?? 0) + group.count);
  if (bySource.size === 0) return [];
  const entries = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
  const other = entries.filter(([source]) => requested.size > 0 || !NOISY_SOURCES.has(source));
  const noisy = entries.filter(([source]) => requested.size === 0 && NOISY_SOURCES.has(source));
  const lines: string[] = [];
  if (other.length > 0) {
    lines.push("", "# Other new events, counted (pass sources to see one, or use query_events)");
    lines.push(other.map(([source, count]) => `${source}${listed.has(source) ? " other" : ""} ${count}`).join(", "));
  }
  if (noisy.length > 0) {
    lines.push("", `Left out as noisy unless listed in sources: ${noisy.map(([source, count]) => `${source} ${count}`).join(", ")}`);
  }
  return lines;
}

export const GET_UPDATES_DESCRIPTION = `What was added to Timeline since you last checked: an index of conversations with new messages, then their messages; one line per calendar event, call recording, show or place visit; recent daily health lines; counts for other sources and for old events imported late. Pass a checkpoint name of your own and Timeline remembers where you left off; or pass since. Edits to existing events are not new.`;

export const GET_UPDATES_SCHEMA = {
  checkpoint: z.string().min(1).optional().describe("A name Timeline keeps your place under; use the same one every time. The last page of an unfiltered catch-up moves it"),
  since: z.string().min(1).optional().describe(`"id:1234" from a reply, or an ISO date or timestamp at most ${DATE_LOOKBACK_DAYS} days back (a date is midnight UTC)`),
  cursor: z.string().min(1).optional().describe("From a More line, passed alone"),
  sources: z.array(z.string().min(1)).min(1).optional().describe("Only these sources, shown in full; noisy ones are left out unless listed"),
  conversation_id: z.string().min(1).optional().describe("Only this conversation, as a heading shows it"),
  health_days: z.number().int().min(0).max(90).optional().describe(`Days of health lines up to today; default ${UPDATES_DEFAULT_HEALTH_DAYS}, or 0 with cursor or conversation_id`),
  max_tokens: z.number().int().min(MAX_TOKENS_MIN).max(MAX_TOKENS_MAX).optional().describe(`Approximate reply size cap, default ${UPDATES_DEFAULT_MAX_TOKENS}`),
};

export async function runGetUpdates(
  db: QueryExecutor,
  params: { checkpoint?: string; since?: string; cursor?: string; sources?: string[]; conversation_id?: string; health_days?: number; max_tokens?: number },
  store?: CheckpointStore,
): Promise<CallToolResult> {
  try {
    const text = await getUpdates(db, {
      checkpoint: params.checkpoint,
      since: params.since,
      cursor: params.cursor,
      sources: params.sources,
      conversationId: params.conversation_id,
      healthDays: params.health_days,
      maxTokens: params.max_tokens,
    }, store);
    return { content: [{ type: "text" as const, text }] };
  } catch (error) {
    if (!(error instanceof UpdatesInputError)) throw error;
    return { isError: true, content: [{ type: "text" as const, text: `Error: ${error.message}` }] };
  }
}
