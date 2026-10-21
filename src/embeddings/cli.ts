import { Database } from "bun:sqlite";
import { Args, Command, HelpDoc, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
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

function asHelpDoc(error: unknown): HelpDoc.HelpDoc {
  return HelpDoc.p(errorMessage(error));
}

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

const limitOption = Options.integer("limit").pipe(
  Options.withDefault(25),
  Options.mapTryCatch(positiveInteger("--limit"), asHelpDoc),
  Options.withDescription("Maximum number of events or results")
);

const concurrencyOption = Options.integer("concurrency").pipe(
  Options.withDefault(8),
  Options.mapTryCatch(positiveInteger("--concurrency"), asHelpDoc),
  Options.withDescription("Embedding requests to keep in flight at once")
);

const sinceOption = Options.text("since").pipe(
  Options.mapTryCatch(parseSince, asHelpDoc),
  Options.optional,
  Options.withDescription("Only index events on or after YYYY-MM-DD or an ISO timestamp with timezone")
);

function filterTermsOption(name: "include" | "exclude"): Options.Options<FilterTerm[]> {
  const flag = `--${name}`;
  return Options.text(name).pipe(
    Options.repeated,
    Options.mapTryCatch(values => values.flatMap(value => parseFilterTerms(value, flag)), asHelpDoc),
    Options.withDescription("SOURCE or SOURCE:TYPE, repeatable and comma-separated")
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
    Effect.catchAll(error =>
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
    if (Exit.isInterrupted(exit)) {
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

const includeOption = filterTermsOption("include");
const excludeOption = filterTermsOption("exclude");

const indexCommand = Command.make(
  "index",
  {
    limit: limitOption,
    concurrency: concurrencyOption,
    since: sinceOption,
    include: includeOption,
    exclude: excludeOption,
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

const queryArgs = Args.text({ name: "query" }).pipe(
  Args.repeated,
  Args.withDescription("Text to embed and search for")
);

function validateSearchQueryTokens(query: string[]): Effect.Effect<boolean> {
  if (query.includes("--since")) return reportSearchOnlyIndexToken("--since only applies to index");
  if (query.includes("--concurrency")) return reportSearchOnlyIndexToken("--concurrency only applies to index");
  if (query.includes("--include")) return reportSearchOnlyIndexToken("--include is only supported by the index command");
  if (query.includes("--exclude")) return reportSearchOnlyIndexToken("--exclude is only supported by the index command");
  return Effect.succeed(true);
}

function reportSearchOnlyIndexToken(message: string): Effect.Effect<boolean> {
  return Effect.sync(() => {
    console.error(message);
    process.exitCode = 1;
    return false;
  });
}

const searchCommand = Command.make(
  "search",
  {
    limit: limitOption,
    query: queryArgs,
  },
  ({ limit, query }) =>
    validateSearchQueryTokens(query).pipe(
      Effect.flatMap(valid =>
        valid
          ? Effect.promise(loadEmbeddingProfile).pipe(
              Effect.flatMap(modelConfig => search(modelConfig, query.join(" ") || undefined, limit))
            )
          : Effect.void
      )
    )
);

const command = Command.make("embeddings").pipe(Command.withSubcommands([indexCommand, searchCommand]));
const cli = Command.run(command, { name: "Timeline Embeddings", version: `v${PRODUCT_VERSION}` });

Effect.suspend(() => cli(Bun.argv)).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
