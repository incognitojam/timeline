import { Database } from "../db/sqlite";
import { Effect } from "effect";
import { conversationTypeClause } from "../db/conversation-types";
import { wrapDatabase } from "../db/pool";
import type { TimelineEvent } from "../db/schema";
import { type RenderIdentityOptions, resolveRenderIdentities } from "../export/display-names";
import { renderEvent } from "../export/render";
import { errorMessage, FatalEmbeddingError } from "./client";
import { contentHash, MAX_RENDERED_BYTES, truncateToBytes } from "./content";
import {
  deleteWindowDocuments,
  getIndexCursor,
  hasVector,
  insertVector,
  listFailedSourceKeys,
  recordEmbeddingFailure,
  setIndexCursor,
  upsertDocument,
  WINDOW_SOURCE_KIND,
} from "./db";
import { embedBatch, type IndexTarget, MAX_BATCH_BYTES, type PendingEmbedding } from "./indexer";

/**
 * Content profile for one source's conversation windows. Each source gets its
 * own profile, and so its own cursor, so changing the pilot source starts that
 * source from its first message.
 */
export function conversationWindowProfile(source: string) {
  return { name: `conversation-window:${source}`, version: 1, formatter: "conversation-window" } as const;
}

/** A silence longer than this ends a conversation session; windows never span one. */
export const WINDOW_GAP_MS = 30 * 60_000;
/** A window closes before the message that would take it past this many UTF-8 bytes. */
export const WINDOW_MAX_BYTES = 3000;
/** Messages a window repeats from the end of the window before it. */
export const WINDOW_OVERLAP_MESSAGES = 2;
/** A longer message line is shortened; its own single-event vector keeps the rest. */
const WINDOW_MAX_LINE_BYTES = 1000;

export interface WindowLine {
  eventId: number;
  timestamp: string;
  /** `HH:MM <Name> text`, as the conversation export renders it. */
  text: string;
  bytes: number;
  /** The conversation's name on this message (the other person in a DM). */
  title: string | null;
}

export interface ConversationWindow {
  lines: WindowLine[];
  /** How many leading lines repeat the previous window. */
  overlap: number;
}

/** Split time-ordered lines wherever more than WINDOW_GAP_MS passes between two of them. */
export function splitSessions<T extends { timestamp: string }>(lines: readonly T[]): T[][] {
  const sessions: T[][] = [];
  let current: T[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    const time = Date.parse(line.timestamp);
    if (current.length > 0 && time - previous > WINDOW_GAP_MS) {
      sessions.push(current);
      current = [];
    }
    current.push(line);
    previous = time;
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

/**
 * Cut one session into windows of at most WINDOW_MAX_BYTES (a window always
 * holds at least one message of its own), each after the first starting with
 * the last WINDOW_OVERLAP_MESSAGES messages of the one before. A one-message
 * session has no windows: its single-event vector already covers it. Cutting
 * runs forward, so a window depends only on the messages up to the one after
 * it.
 */
export function cutWindows(session: readonly WindowLine[]): ConversationWindow[] {
  if (session.length < 2) return [];
  const windows: ConversationWindow[] = [];
  let next = 0;
  while (next < session.length) {
    const overlap = windows.length === 0 ? 0 : Math.min(WINDOW_OVERLAP_MESSAGES, next);
    const start = next - overlap;
    let bytes = 0;
    for (let index = start; index < next; index++) bytes += lineBytes(session, index);
    do {
      bytes += lineBytes(session, next);
      next++;
    } while (next < session.length && bytes + lineBytes(session, next) <= WINDOW_MAX_BYTES);
    windows.push({ lines: session.slice(start, next), overlap });
  }
  return windows;
}

function lineBytes(lines: readonly WindowLine[], index: number): number {
  const line = lines[index];
  if (!line) throw new Error(`No window line at ${index}`);
  return line.bytes + 1; // and its newline
}

/** `[source, source_account, conversation_id]` as JSON: the source_key of every window of a conversation. */
export function conversationKey(source: string, sourceAccount: string | null, conversationId: string): string {
  return JSON.stringify([source, sourceAccount, conversationId]);
}

export function parseConversationKey(key: string): { source: string; sourceAccount: string | null; conversationId: string } {
  const parsed: unknown = JSON.parse(key);
  if (
    !Array.isArray(parsed) ||
    typeof parsed[0] !== "string" ||
    (parsed[1] !== null && typeof parsed[1] !== "string") ||
    typeof parsed[2] !== "string"
  ) {
    throw new Error(`Invalid conversation key ${key}`);
  }
  return { source: parsed[0], sourceAccount: parsed[1], conversationId: parsed[2] };
}

function isoMinute(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}

/** `discord conversation: Rowan, 2023-12-11 03:07–03:13 UTC` */
export function windowHeader(source: string, title: string | null, start: string, end: string): string {
  const from = isoMinute(start);
  const to = isoMinute(end);
  const toPart = to.slice(0, 10) === from.slice(0, 10) ? to.slice(11) : to;
  return `${source} conversation: ${title ?? "(untitled)"}, ${from}–${toPart} UTC`;
}

export function renderWindow(header: string, window: ConversationWindow): string {
  return [header, ...window.lines.map(line => line.text)].join("\n");
}

function renderLine(event: TimelineEvent, identities: RenderIdentityOptions): string {
  // renderEvent leads with "YYYY-MM-DD HH:MM "; a window line keeps the time,
  // and the window's header carries the date.
  return truncateToBytes(renderEvent(event, identities).slice(11), WINDOW_MAX_LINE_BYTES);
}

const SNIPPET_CHARS = 240;

/** The window's own messages without their times, for search output. */
function windowSnippet(window: ConversationWindow): string {
  return window.lines
    .slice(window.overlap)
    .map(line => line.text.slice(6))
    .join(" / ")
    .slice(0, SNIPPET_CHARS);
}

export interface WindowIndexCounts {
  /** Windows rendered for closed sessions this run, new or unchanged. */
  windows: number;
  embedded: number;
  embeddedBytes: number;
  /** Windows that already had a vector. */
  reused: number;
  /** Window documents deleted because re-windowing replaced them. */
  removed: number;
  errors: number;
}

export interface WindowIndexOutcome {
  /** Conversations still waiting to be windowed, including ones whose last session is still open. */
  pendingConversations: number;
  caughtUp: boolean;
}

interface PendingRow {
  conversation_key: string;
  start_timestamp: string;
  end_timestamp: string;
}

/** Messages read at a time while finding where a session starts or ends. */
const SESSION_PAGE = 500;

interface PlannedWindow {
  window: ConversationWindow;
  title: string | null;
  rendered: string;
  hash: string;
  start: string;
  end: string;
}

interface ConversationPlan {
  /** Windows of closed sessions that end at or after the pending start, in order. */
  windows: PlannedWindow[];
  /** Hashes of every current window of the sessions planned, kept when replaced windows are deleted. */
  keepHashes: Set<string>;
  /** First message of a session that is still open, which stays pending. */
  openStart: string | null;
}

/**
 * Embed conversation windows for one source, beside its single-event vectors.
 *
 * Each run first walks events.id past this profile's cursor and marks the
 * time range of new or late messages in each conversation as pending, then
 * windows pending ranges until none remain, `maxWindows` windows have been
 * handled, or `deadline` passes. A pending range is re-windowed from the start
 * of its session through the end of the session its last new message is in.
 * Only closed sessions (last message more than WINDOW_GAP_MS before `now`) are
 * embedded; an open one stays pending. Window documents are keyed by content
 * hash, so unchanged windows are reused, and after the new windows' vectors
 * are stored the window documents they replaced are deleted. A window the
 * provider rejects is recorded in embedding_failures and skipped, as photos
 * are. Nothing else in embeddings.db is deleted or changed. Only one window
 * run at a time may use an embeddings.db; a second fails without doing
 * anything.
 */
export function indexConversationWindows(
  target: IndexTarget,
  timelineDb: Database,
  options: {
    source: string;
    batchSize: number;
    concurrency: number;
    deadline: number;
    now?: number;
    maxWindows?: number;
  },
  counts: WindowIndexCounts
): Effect.Effect<WindowIndexOutcome, FatalEmbeddingError> {
  const { embeddingsDb, client, contentProfile, modelProfile } = target;
  const now = options.now ?? Date.now();
  const windowsPerStep = options.concurrency * (MAX_BATCH_BYTES / MAX_RENDERED_BYTES);
  // A timestamp SQLite cannot read is left out rather than misplaced.
  const messageClause = `julianday(timestamp) IS NOT NULL AND conversation_id IS NOT NULL AND ${conversationTypeClause()}`;
  const utc = "strftime('%Y-%m-%dT%H:%M:%fZ', julianday(timestamp))";
  const conversationClause = `source = ? AND source_account IS ? AND conversation_id = ? AND ${messageClause}`;

  // Timestamps are compared by instant, never as text: a source may keep its
  // own UTC offset, and an offset sorts apart from the instant it names.
  const selectNew = timelineDb.prepare(
    `SELECT source_account, conversation_id,
       strftime('%Y-%m-%dT%H:%M:%fZ', MIN(julianday(timestamp))) AS start,
       strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday(timestamp))) AS end
     FROM events WHERE source = ? AND id > ? AND ${messageClause}
     GROUP BY source_account, conversation_id`
  );
  const selectMaxId = timelineDb.prepare("SELECT MAX(id) AS id FROM events WHERE source = ? AND id > ?");
  const selectEarlier = timelineDb.prepare(
    `SELECT ${utc} AS timestamp FROM events WHERE ${conversationClause} AND julianday(timestamp) < julianday(?)
     ORDER BY julianday(timestamp) DESC, id DESC LIMIT ${SESSION_PAGE}`
  );
  const selectLater = timelineDb.prepare(
    `SELECT ${utc} AS timestamp FROM events WHERE ${conversationClause} AND julianday(timestamp) > julianday(?)
     ORDER BY julianday(timestamp), id LIMIT ${SESSION_PAGE}`
  );
  const selectBetween = timelineDb.prepare(
    `SELECT *, ${utc} AS utc_timestamp FROM events WHERE ${conversationClause} AND julianday(timestamp) BETWEEN julianday(?) AND julianday(?)
     ORDER BY julianday(timestamp), id`
  );
  const upsertPending = embeddingsDb.prepare(
    `INSERT INTO conversation_window_pending (content_profile_id, model_profile_id, conversation_key, start_timestamp, end_timestamp)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (content_profile_id, model_profile_id, conversation_key) DO UPDATE SET
       start_timestamp = min(start_timestamp, excluded.start_timestamp),
       end_timestamp = max(end_timestamp, excluded.end_timestamp)`
  );
  const selectPending = embeddingsDb.prepare(
    `SELECT conversation_key, start_timestamp, end_timestamp FROM conversation_window_pending
     WHERE content_profile_id = ? AND model_profile_id = ? ORDER BY end_timestamp DESC`
  );
  const advancePending = embeddingsDb.prepare(
    `UPDATE conversation_window_pending SET start_timestamp = ?
     WHERE content_profile_id = ? AND model_profile_id = ? AND conversation_key = ?`
  );
  const clearPending = embeddingsDb.prepare(
    `DELETE FROM conversation_window_pending
     WHERE content_profile_id = ? AND model_profile_id = ? AND conversation_key = ?`
  );
  const insertSpan = embeddingsDb.prepare(
    "INSERT OR IGNORE INTO conversation_windows (document_id, conversation_key, start_timestamp, end_timestamp) VALUES (?, ?, ?, ?)"
  );
  const selectOverlapping = embeddingsDb.prepare(
    `SELECT cw.document_id, d.content_hash FROM conversation_windows cw
     JOIN embedding_documents d ON d.id = cw.document_id
     WHERE cw.conversation_key = ? AND d.content_profile_id = ? AND cw.start_timestamp <= ? AND cw.end_timestamp >= ?`
  );

  /** Mark the conversations with messages past the cursor as pending, then move the cursor past them. */
  const markNewMessages = () =>
    embeddingsDb.transaction(() => {
      const cursor = getIndexCursor(embeddingsDb, contentProfile.id, modelProfile.id);
      const maxId = (selectMaxId.get(options.source, cursor) as { id: number | null }).id;
      if (maxId === null) return;
      const rows = selectNew.all(options.source, cursor) as {
        source_account: string | null;
        conversation_id: string;
        start: string;
        end: string;
      }[];
      for (const row of rows) {
        upsertPending.run(
          contentProfile.id,
          modelProfile.id,
          conversationKey(options.source, row.source_account, row.conversation_id),
          row.start,
          row.end
        );
      }
      setIndexCursor(embeddingsDb, contentProfile.id, modelProfile.id, maxId);
    }).immediate();

  /** The first (`earlier`) or last (`later`) message of the session that holds `timestamp`. */
  const sessionBoundary = (params: (string | null)[], timestamp: string, direction: "earlier" | "later"): string => {
    const select = direction === "earlier" ? selectEarlier : selectLater;
    let boundary = timestamp;
    for (;;) {
      const page = select.all(...params, boundary) as { timestamp: string }[];
      for (const row of page) {
        if (Math.abs(Date.parse(boundary) - Date.parse(row.timestamp)) > WINDOW_GAP_MS) return boundary;
        boundary = row.timestamp;
      }
      if (page.length < SESSION_PAGE) return boundary;
    }
  };

  const plan = async (row: PendingRow): Promise<ConversationPlan> => {
    const conversation = parseConversationKey(row.conversation_key);
    const params = [conversation.source, conversation.sourceAccount, conversation.conversationId];
    // Only the sessions the pending range touches: later sessions are unchanged by it.
    const events = selectBetween.all(
      ...params,
      sessionBoundary(params, row.start_timestamp, "earlier"),
      sessionBoundary(params, row.end_timestamp, "later")
    ) as (TimelineEvent & { utc_timestamp: string })[];
    const identities = await resolveRenderIdentities(wrapDatabase(timelineDb), events);
    // Times come from SQLite's reading of each timestamp, so they agree with the queries above.
    const lines = events.map((event): WindowLine => {
      const text = renderLine(event, identities);
      return { eventId: event.id, timestamp: event.utc_timestamp, text, bytes: Buffer.byteLength(text), title: event.title };
    });
    const pendingStart = Date.parse(row.start_timestamp);

    const result: ConversationPlan = { windows: [], keepHashes: new Set(), openStart: null };
    for (const session of splitSessions(lines)) {
      const first = session[0];
      const last = session.at(-1);
      if (!first || !last) continue;
      if (Date.parse(last.timestamp) >= now - WINDOW_GAP_MS) {
        result.openStart = first.timestamp;
        break;
      }
      for (const window of cutWindows(session)) {
        const start = window.lines[0]?.timestamp;
        const lastLine = window.lines.at(-1);
        if (!start || !lastLine) throw new Error("Empty conversation window");
        const end = lastLine.timestamp;
        // The name as of the window's last message, so a later rename leaves the window alone.
        const title = lastLine.title;
        const rendered = renderWindow(windowHeader(conversation.source, title, start, end), window);
        // Members are hashed too, so two windows that render alike stay apart.
        const members = window.lines.map(entry => entry.eventId).join(",");
        const hash = contentHash(`${row.conversation_key}\n${members}\n${rendered}`);
        result.keepHashes.add(hash);
        if (Date.parse(end) >= pendingStart) {
          result.windows.push({
            window,
            title,
            rendered,
            hash,
            start,
            end,
          });
        }
      }
    }
    return result;
  };

  /** Store a run of a conversation's windows and the vectors they lack, in one transaction per write. */
  const embedChunk = (conversation: string, chunk: readonly PlannedWindow[], failed: Set<string>) =>
    Effect.gen(function* () {
      const hashByDocument = new Map<number, string>();
      const pending = embeddingsDb.transaction(() => {
        const toEmbed: PendingEmbedding[] = [];
        for (const planned of chunk) {
          const eventIds = planned.window.lines.map(line => line.eventId);
          const document = upsertDocument(embeddingsDb, {
            sourceKind: WINDOW_SOURCE_KIND,
            sourceKey: conversation,
            title: planned.title,
            snippet: windowSnippet(planned.window),
            startTimestamp: planned.start,
            endTimestamp: planned.end,
            contentProfileId: contentProfile.id,
            contentProfileVersion: contentProfile.version,
            renderedContent: planned.rendered,
            contentHash: planned.hash,
            eventIds,
            eventRoles: eventIds.map((_, index) => (index < planned.window.overlap ? "overlap" : "primary")),
          });
          insertSpan.run(document.id, conversation, planned.start, planned.end);
          if (hasVector(embeddingsDb, document.id, modelProfile.id, "window")) {
            counts.reused++;
            continue;
          }
          // Rejected by the provider before; see embedding_failures.
          if (failed.has(planned.hash)) continue;
          const firstOwn = planned.window.lines[planned.window.overlap];
          if (!firstOwn) throw new Error("Conversation window has no message of its own");
          hashByDocument.set(document.id, planned.hash);
          toEmbed.push({
            eventId: firstOwn.eventId,
            documentId: document.id,
            renderedContent: planned.rendered,
            renderedBytes: Buffer.byteLength(planned.rendered),
          });
        }
        return toEmbed;
      })();
      const results = yield* Effect.forEach(batches(pending, options.batchSize), batch => embedBatch(client, batch), {
        concurrency: options.concurrency,
      });
      for (const result of results.flat()) {
        if ("error" in result) {
          // A per-input rejection recurs, so it is recorded and skipped, as photos are.
          counts.errors++;
          const hash = hashByDocument.get(result.item.documentId);
          if (!hash) throw new Error(`No window hash for document ${result.item.documentId}`);
          recordEmbeddingFailure(embeddingsDb, contentProfile.id, modelProfile.id, hash, result.error.message);
          failed.add(hash);
          console.error(`Conversation window: ${result.error.message}`);
          continue;
        }
        if (insertVector(embeddingsDb, result.item.documentId, modelProfile.id, result.vector, "window")) {
          counts.embedded++;
          counts.embeddedBytes += result.item.renderedBytes;
        }
      }
    });

  /** Delete the windows a chunk replaced and move the conversation's pending range on. */
  const commitChunk = (
    conversation: string,
    chunk: readonly PlannedWindow[],
    keepHashes: ReadonlySet<string>,
    resumeAt: string | null
  ) =>
    embeddingsDb.transaction(() => {
      const first = chunk[0];
      const last = chunk.at(-1);
      if (first && last) {
        const replaced = (
          selectOverlapping.all(conversation, contentProfile.id, last.end, first.start) as {
            document_id: number;
            content_hash: string;
          }[]
        ).filter(document => !keepHashes.has(document.content_hash));
        deleteWindowDocuments(
          embeddingsDb,
          replaced.map(document => document.document_id)
        );
        counts.removed += replaced.length;
      }
      const key = [contentProfile.id, modelProfile.id, conversation];
      if (resumeAt === null) clearPending.run(...key);
      else advancePending.run(resumeAt, ...key);
    }).immediate();

  const run = Effect.gen(function* () {
    markNewMessages();
    const failed = listFailedSourceKeys(embeddingsDb, contentProfile.id, modelProfile.id);
    let progressed = false;
    const stop = () =>
      (options.maxWindows !== undefined && counts.windows >= options.maxWindows) ||
      (progressed && Date.now() >= options.deadline);

    // Each conversation is planned once a run, then windowed a chunk at a time.
    for (const row of selectPending.all(contentProfile.id, modelProfile.id) as PendingRow[]) {
      if (stop()) return false;
      const conversationPlan = yield* Effect.promise(() => plan(row));
      const { windows } = conversationPlan;
      if (windows.length === 0) commitChunk(row.conversation_key, [], conversationPlan.keepHashes, conversationPlan.openStart);
      let from = 0;
      while (from < windows.length) {
        if (from > 0 && stop()) return false;
        const room = options.maxWindows === undefined ? windowsPerStep : options.maxWindows - counts.windows;
        let to = from + Math.max(1, Math.min(windowsPerStep, room));
        // The pending range resumes at the next window's end, so a chunk takes
        // every window ending at the same time as its last one.
        while (to < windows.length && windows[to]?.end === windows[to - 1]?.end) to++;
        const chunk = windows.slice(from, to);
        yield* embedChunk(row.conversation_key, chunk, failed);
        counts.windows += chunk.length;
        commitChunk(row.conversation_key, chunk, conversationPlan.keepHashes, windows[to]?.end ?? conversationPlan.openStart);
        progressed = true;
        from = to;
      }
    }
    return true;
  });

  return Effect.acquireUseRelease(
    Effect.sync(() => acquireWindowRunLock(embeddingsDb)),
    lock =>
      lock
        ? run.pipe(
            Effect.map((caughtUp): WindowIndexOutcome => ({
              pendingConversations: (selectPending.all(contentProfile.id, modelProfile.id) as PendingRow[]).length,
              caughtUp,
            }))
          )
        : Effect.fail(
            new FatalEmbeddingError({
              message: "Another conversation-window run is using this embeddings.db; this one did nothing. Try again once it finishes.",
            })
          ),
    lock => Effect.sync(() => lock?.close())
  );
}

/**
 * Hold a write lock on a file beside embeddings.db for the length of a
 * window run, so a second run (the CLI while the service runs, say) is
 * refused rather than racing the first. The operating system drops the lock
 * if the process dies. Null when another run holds it.
 */
function acquireWindowRunLock(embeddingsDb: Database): Database | null {
  const lock = new Database(`${embeddingsDb.filename}.windows-lock`);
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    lock.exec("BEGIN IMMEDIATE");
    return lock;
  } catch (error) {
    lock.close();
    if (/locked|busy/i.test(errorMessage(error))) return null;
    throw error;
  }
}

/** Group embeddings into requests of at most batchSize documents and MAX_BATCH_BYTES. */
function batches(items: readonly PendingEmbedding[], batchSize: number): PendingEmbedding[][] {
  const result: PendingEmbedding[][] = [];
  let current: PendingEmbedding[] = [];
  let bytes = 0;
  for (const item of items) {
    if (current.length > 0 && (current.length >= batchSize || bytes + item.renderedBytes > MAX_BATCH_BYTES)) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += item.renderedBytes;
  }
  if (current.length > 0) result.push(current);
  return result;
}
