import { Database } from "../db/sqlite";
import { Effect } from "effect";
import { EVENT_FOR_EMBEDDING_COLUMNS, EVENT_LEAN_PROFILE, type EventForEmbedding } from "./content";
import { createEmbeddingClient, type EmbeddingProfileConfig } from "./config";
import { buildCorpusWhere, type CorpusFilterTerm } from "./corpus";
import { ensureContentProfile, ensureModelProfile, getEmbeddingsDb, initEmbeddingsDb } from "./db";
import { type IndexCounts, indexEvents } from "./indexer";
import { conversationWindowProfile, indexConversationWindows, type WindowIndexCounts, type WindowIndexOutcome } from "./windows";

// A whole source (no `type`) or a single source/type pair. SOURCE:TYPE values
// split on the first colon so event types containing colons (e.g.
// "spotify:listen:track") are matched intact.
type FilterTerm = CorpusFilterTerm;

/** The index command's defaults when `--limit` or `--concurrency` is omitted. */
export const DEFAULT_INDEX_LIMIT = 25;
export const DEFAULT_INDEX_CONCURRENCY = 8;

export interface IndexFilters {
  include: FilterTerm[];
  exclude: FilterTerm[];
}

export interface CliIndexCounts extends IndexCounts {
  limit: number;
  selected: number;
}

export type SinceFilter =
  | { kind: "date"; value: string }
  | { kind: "timestamp"; value: string };

export function parseSince(value: string): SinceFilter {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && isValidDateOnly(value)) return { kind: "date", value };
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    isValidDateOnly(value.slice(0, 10)) &&
    !Number.isNaN(Date.parse(value))
  ) {
    return { kind: "timestamp", value: new Date(value).toISOString() };
  }
  throw new Error("--since must be a YYYY-MM-DD date or ISO timestamp with timezone");
}

function isValidDateOnly(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseFilterTerms(value: string | undefined, flag: string): FilterTerm[] {
  if (!value) throw new Error(`${flag} requires a value`);
  const parts = value
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error(`${flag} requires at least one value`);
  return parts.map(part => {
    const separator = part.indexOf(":");
    if (separator === -1) return { source: part };
    if (separator === 0 || separator === part.length - 1) {
      throw new Error(`${flag} values must be SOURCE or SOURCE:TYPE, got "${part}"`);
    }
    return { source: part.slice(0, separator), type: part.slice(separator + 1) };
  });
}

function buildIndexWhere(filters: IndexFilters, since?: SinceFilter): { clause: string; params: string[] } {
  const corpus = buildCorpusWhere(filters);
  const conditions = [corpus.clause];
  const params = [...corpus.params];

  if (since?.kind === "date") {
    conditions.push("timestamp >= ?");
    params.push(since.value);
  }
  if (since?.kind === "timestamp") {
    conditions.push("julianday(timestamp) >= julianday(?)");
    params.push(since.value);
  }

  return { clause: conditions.join(" AND "), params };
}

export interface IndexRun {
  timelineDbPath: string;
  embeddingsDbPath: string;
  modelConfig: EmbeddingProfileConfig;
  limit: number;
  concurrency: number;
  batchSize: number;
  filters: IndexFilters;
  since?: SinceFilter;
}

/**
 * Selects up to `limit` corpus events and embeds them, recording progress in
 * `counts` as it goes so an interrupted run can still report it. A fatal error
 * (bad config / dead provider) is counted and ends the run.
 */
export function runIndex(run: IndexRun, counts: CliIndexCounts): Effect.Effect<void> {
  const program = Effect.gen(function* () {
    const embeddingsDb = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const db = getEmbeddingsDb(run.embeddingsDbPath);
        initEmbeddingsDb(db);
        return db;
      }),
      db => Effect.sync(() => db.close())
    );
    const timelineDb = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(run.timelineDbPath, { readonly: true })),
      db => Effect.sync(() => db.close())
    );
    const contentProfile = ensureContentProfile(embeddingsDb, EVENT_LEAN_PROFILE);
    const modelProfile = ensureModelProfile(embeddingsDb, run.modelConfig);
    const client = createEmbeddingClient(run.modelConfig);

    const where = buildIndexWhere(run.filters, run.since);
    const events = timelineDb
      .prepare(
        `SELECT ${EVENT_FOR_EMBEDDING_COLUMNS}
         FROM events
         WHERE ${where.clause}
         ORDER BY COALESCE(timestamp, ''), id
         LIMIT ?`
      )
      .all(...where.params, run.limit) as EventForEmbedding[];
    counts.selected = events.length;

    yield* indexEvents(
      { embeddingsDb, client, contentProfile, modelProfile },
      events,
      { batchSize: run.batchSize, concurrency: run.concurrency },
      counts
    );
  }).pipe(Effect.scoped);

  return program.pipe(
    // A fatal error (bad config / dead provider) aborts after the first failure
    // instead of hammering the provider once per event.
    Effect.catchTag("FatalEmbeddingError", error =>
      Effect.sync(() => {
        counts.errors++;
        console.error(error.message);
      })
    )
  );
}

export interface WindowIndexRun {
  timelineDbPath: string;
  embeddingsDbPath: string;
  modelConfig: EmbeddingProfileConfig;
  source: string;
  /** Stop starting new work once this many windows have been handled. */
  limit: number;
  concurrency: number;
  batchSize: number;
}

export type CliWindowIndexCounts = WindowIndexCounts & { source: string; limit: number } & Partial<WindowIndexOutcome>;

/**
 * Window one source's conversations, as the background indexer does, through
 * the same cursor and pending ranges, until caught up or `limit` windows have
 * been handled. A fatal error is counted and ends the run.
 */
export function runWindowIndex(run: WindowIndexRun, counts: CliWindowIndexCounts): Effect.Effect<void> {
  const program = Effect.gen(function* () {
    const embeddingsDb = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const db = getEmbeddingsDb(run.embeddingsDbPath);
        initEmbeddingsDb(db);
        return db;
      }),
      db => Effect.sync(() => db.close())
    );
    const timelineDb = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(run.timelineDbPath, { readonly: true })),
      db => Effect.sync(() => db.close())
    );
    const outcome = yield* indexConversationWindows(
      {
        embeddingsDb,
        client: createEmbeddingClient(run.modelConfig),
        contentProfile: ensureContentProfile(embeddingsDb, conversationWindowProfile(run.source)),
        modelProfile: ensureModelProfile(embeddingsDb, run.modelConfig),
      },
      timelineDb,
      {
        source: run.source,
        batchSize: run.batchSize,
        concurrency: run.concurrency,
        deadline: Number.POSITIVE_INFINITY,
        maxWindows: run.limit,
      },
      counts
    );
    Object.assign(counts, outcome);
  }).pipe(Effect.scoped);

  return program.pipe(
    Effect.catchTag("FatalEmbeddingError", error =>
      Effect.sync(() => {
        counts.errors++;
        console.error(error.message);
      })
    )
  );
}
