import { Database } from "bun:sqlite";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { getTimelineDbPath } from "../db/paths";
import { PRODUCT_VERSION } from "../product-version";
import { loadConfig } from "../config";
import { EVENT_FOR_EMBEDDING_COLUMNS, EVENT_LEAN_PROFILE, type EventForEmbedding } from "./content";
import { errorMessage } from "./client";
import { createEmbeddingClient, type EmbeddingProfileConfig, resolveEmbeddingProfile } from "./config";
import { buildCorpusWhere, type CorpusFilterTerm } from "./corpus";
import { ensureContentProfile, ensureModelProfile, getEmbeddingsDb, initEmbeddingsDb, searchVectors } from "./db";
import { type IndexCounts, indexEvents, readEmbeddingBatchSize } from "./indexer";

// A whole source (no `type`) or a single source/type pair. SOURCE:TYPE values
// split on the first colon so event types containing colons (e.g.
// "spotify:listen:track") are matched intact.
type FilterTerm = CorpusFilterTerm;

interface IndexFilters {
  include: FilterTerm[];
  exclude: FilterTerm[];
}

interface CliIndexCounts extends IndexCounts {
  limit: number;
  selected: number;
}

function reportIndexCounts(counts: CliIndexCounts): Effect.Effect<void> {
  return Effect.sync(() => {
    console.log(JSON.stringify(counts));
    // Partial progress is committed (and recoverable on re-run), but a clean
    // exit would let a misconfigured model or a down provider look successful
    // to schedulers/CI while writing no vectors. Signal "not fully indexed".
    if (counts.errors > 0 && process.exitCode === undefined) process.exitCode = 1;
  });
}

type SinceFilter =
  | { kind: "date"; value: string }
  | { kind: "timestamp"; value: string };

function positiveInteger(flag: string): (value: number) => number {
  return value => {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
    return value;
  };
}

function parseSince(value: string): SinceFilter {
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

function parseFilterTerms(value: string | undefined, flag: string): FilterTerm[] {
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

const limitFlag = Flag.Int("limit").pipe(
  Flag.withDefault(25),
  Flag.mapTryCatch(positiveInteger("--limit"), errorMessage),
  Flag.withDescription("Maximum number of events or results")
);

const concurrencyFlag = Flag.Int("concurrency").pipe(
  Flag.withDefault(8),
  Flag.mapTryCatch(positiveInteger("--concurrency"), errorMessage),
  Flag.withDescription("Embedding requests to keep in flight at once")
);

const sinceFlag = Flag.String("since").pipe(
  Flag.mapTryCatch(parseSince, errorMessage),
  Flag.optional,
  Flag.withDescription("Only index events on or after YYYY-MM-DD or an ISO timestamp with timezone")
);

function filterTermsFlag(name: "include" | "exclude"): Flag.Flag<FilterTerm[]> {
  const flag = `--${name}`;
  return Flag.String(name).pipe(
    Flag.atLeast(0),
    Flag.mapTryCatch(values => values.flatMap(value => parseFilterTerms(value, flag)), errorMessage),
    Flag.withDescription("SOURCE or SOURCE:TYPE, repeatable and comma-separated")
  );
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

/** Open the embeddings DB (and load sqlite-vec) as a scoped, auto-closed resource. */
const acquireEmbeddingsDb = Effect.acquireRelease(
  Effect.sync(() => {
    const db = getEmbeddingsDb();
    initEmbeddingsDb(db);
    return db;
  }),
  db => Effect.sync(() => db.close())
);

async function loadEmbeddingProfile(): Promise<EmbeddingProfileConfig> {
  return resolveEmbeddingProfile((await loadConfig()).embeddings);
}

function index(
  modelConfig: EmbeddingProfileConfig,
  limit: number,
  concurrency: number,
  filters: IndexFilters,
  since?: SinceFilter
): Effect.Effect<void> {
  const batchSize = readEmbeddingBatchSize();
  const counts: CliIndexCounts = { limit, selected: 0, created: 0, reused: 0, embedded: 0, skipped: 0, errors: 0 };

  const program = Effect.gen(function* () {
    const embeddingsDb = yield* acquireEmbeddingsDb;
    const timelineDb = yield* Effect.acquireRelease(
      Effect.sync(() => new Database(getTimelineDbPath(), { readonly: true })),
      db => Effect.sync(() => db.close())
    );
    const contentProfile = ensureContentProfile(embeddingsDb, EVENT_LEAN_PROFILE);
    const modelProfile = ensureModelProfile(embeddingsDb, modelConfig);
    const client = createEmbeddingClient(modelConfig);

    const where = buildIndexWhere(filters, since);
    const events = timelineDb
      .prepare(
        `SELECT ${EVENT_FOR_EMBEDDING_COLUMNS}
         FROM events
         WHERE ${where.clause}
         ORDER BY COALESCE(timestamp, ''), id
         LIMIT ?`
      )
      .all(...where.params, limit) as EventForEmbedding[];
    counts.selected = events.length;

    yield* indexEvents({ embeddingsDb, client, contentProfile, modelProfile }, events, { batchSize, concurrency }, counts);
  }).pipe(Effect.scoped);

  return program.pipe(
    // A fatal error (bad config / dead provider) aborts after the first failure
    // instead of hammering the provider once per event.
    Effect.catchTag("FatalEmbeddingError", error =>
      Effect.sync(() => {
        counts.errors++;
        console.error(error.message);
      })
    ),
    Effect.ensuring(reportIndexCounts(counts))
  );
}

function search(modelConfig: EmbeddingProfileConfig, query: string | undefined, limit: number): Effect.Effect<void> {
  if (!query) throw new Error("search requires a query");

  return Effect.gen(function* () {
    const embeddingsDb = yield* acquireEmbeddingsDb;
    const modelProfile = ensureModelProfile(embeddingsDb, modelConfig);
    const client = createEmbeddingClient(modelConfig);
    const vector = yield* client.embedQuery(query);
    const hits = searchVectors(embeddingsDb, vector, modelProfile.id, limit);
    console.log(JSON.stringify(hits, null, 2));
  }).pipe(
    Effect.scoped,
    // Either error kind means the query could not be embedded; report and exit nonzero.
    Effect.catch(error =>
      Effect.sync(() => {
        console.error(error.message);
        process.exitCode = 1;
      })
    )
  );
}

async function runWithSigintReport(effect: Effect.Effect<void>): Promise<void> {
  const fiber = Effect.runFork(effect);
  let interrupted = false;

  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.exitCode = 130;
    Effect.runFork(Fiber.interrupt(fiber));
  };

  process.once("SIGINT", onSigint);
  try {
    const exit = await Effect.runPromise(Fiber.await(fiber));
    if (Exit.hasInterrupts(exit)) {
      process.exit(130);
    }
    if (Exit.isFailure(exit)) {
      console.error(Cause.pretty(exit.cause));
      if (process.exitCode === undefined) process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

const indexCommand = Command.make(
  "index",
  {
    limit: limitFlag,
    concurrency: concurrencyFlag,
    since: sinceFlag,
    include: filterTermsFlag("include"),
    exclude: filterTermsFlag("exclude"),
  },
  ({ limit, concurrency, since, include, exclude }) => {
    return Effect.promise(async () =>
      runWithSigintReport(
        index(await loadEmbeddingProfile(), limit, concurrency, { include, exclude }, Option.getOrUndefined(since))
      )
      // runMain also interrupts on SIGINT and would exit 0 before the index
      // fiber finishes reporting; runWithSigintReport owns the shutdown instead.
    ).pipe(Effect.uninterruptible);
  }
);

const queryArgument = Argument.String("query").pipe(
  Argument.variadic,
  Argument.withDescription("Text to embed and search for")
);

const searchCommand = Command.make(
  "search",
  {
    limit: limitFlag,
    query: queryArgument,
  },
  ({ limit, query }) =>
    Effect.promise(loadEmbeddingProfile).pipe(
      Effect.flatMap(modelConfig => search(modelConfig, query.join(" ") || undefined, limit))
    )
);

const command = Command.make("embeddings").pipe(Command.withSubcommands([indexCommand, searchCommand]));

Command.run(command, { version: PRODUCT_VERSION }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain);
