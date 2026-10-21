import type { Database } from "bun:sqlite";
import { Chunk, Effect, Sink, Stream } from "effect";
import { errorMessage, EventEmbeddingError, type FatalEmbeddingError, type OpenAIEmbeddingClient } from "./client";
import { contentHash, EVENT_FOR_EMBEDDING_COLUMNS, type EventForEmbedding, MAX_RENDERED_BYTES, renderEventLean } from "./content";
import { buildCorpusSourceWhere, buildCorpusWhere } from "./corpus";
import {
  type ContentProfile,
  getIndexCursor,
  hasVector,
  insertVector,
  type ModelProfile,
  setIndexCursor,
  upsertDocument,
} from "./db";

export interface IndexCounts {
  created: number;
  reused: number;
  embedded: number;
  skipped: number;
  errors: number;
}

export interface IndexTarget {
  embeddingsDb: Database;
  client: OpenAIEmbeddingClient;
  contentProfile: ContentProfile;
  modelProfile: ModelProfile;
}

/** Documents per embeddings request, unless MAX_BATCH_BYTES closes it first. */
const DEFAULT_BATCH_SIZE = 64;

export function readEmbeddingBatchSize(): number {
  const value = process.env.TIMELINE_EMBEDDING_BATCH_SIZE;
  if (!value) return DEFAULT_BATCH_SIZE;
  const size = Number(value);
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("TIMELINE_EMBEDDING_BATCH_SIZE must be a positive integer");
  }
  return size;
}

/**
 * UTF-8 bytes of rendered documents sent in one embeddings request. A request
 * must finish within the provider timeout while sharing the server with the
 * other requests in flight, so long documents travel in smaller batches.
 */
export const MAX_BATCH_BYTES = 8 * MAX_RENDERED_BYTES;

interface PendingEmbedding {
  eventId: number;
  documentId: number;
  renderedContent: string;
  renderedBytes: number;
}

type EmbeddingResult =
  | { item: PendingEmbedding; vector: number[] }
  | { item: PendingEmbedding; error: EventEmbeddingError };

function eventIndexingError(eventId: number, action: string, cause: unknown): EventEmbeddingError {
  return new EventEmbeddingError({ message: `Failed to ${action} for event ${eventId}: ${errorMessage(cause)}` });
}

function recordEventError(counts: IndexCounts, error: EventEmbeddingError): Effect.Effect<void> {
  return Effect.sync(() => {
    counts.errors++;
    console.error(error.message);
  });
}

/**
 * Embed a batch without touching the database. When the provider rejects the
 * batch for one input, the batch is split and each half retried until only the
 * bad input remains, which comes back as an error for its event.
 */
function embedBatch(
  client: OpenAIEmbeddingClient,
  items: readonly PendingEmbedding[]
): Effect.Effect<EmbeddingResult[], FatalEmbeddingError> {
  if (items.length === 0) return Effect.succeed([]);
  return client.embedDocuments(items.map(item => item.renderedContent)).pipe(
    Effect.map(vectors =>
      items.map((item, index): EmbeddingResult => {
        const vector = vectors[index];
        return vector
          ? { item, vector }
          : { item, error: eventIndexingError(item.eventId, "read embedding response", "missing vector") };
      })
    ),
    Effect.catchTag("EventEmbeddingError", error => {
      if (items.length === 1) {
        return Effect.succeed(items.map(item => ({ item, error: eventIndexingError(item.eventId, "embed content", error) })));
      }
      const midpoint = Math.floor(items.length / 2);
      return Effect.zipWith(
        embedBatch(client, items.slice(0, midpoint)),
        embedBatch(client, items.slice(midpoint)),
        (first, second) => [...first, ...second]
      );
    })
  );
}

function writeEmbeddingResults(
  embeddingsDb: Database,
  modelProfileId: number,
  results: EmbeddingResult[],
  counts: IndexCounts
): Effect.Effect<void> {
  return Effect.forEach(
    results,
    result => {
      if ("error" in result) return recordEventError(counts, result.error);
      const { item, vector } = result;
      return Effect.try({
        try: () => insertVector(embeddingsDb, item.documentId, modelProfileId, vector),
        catch: cause => eventIndexingError(item.eventId, "store embedding vector", cause),
      }).pipe(
        Effect.tap(inserted =>
          Effect.sync(() => {
            // Another index run stored this document's vector first.
            counts[inserted ? "embedded" : "skipped"]++;
          })
        ),
        Effect.catchTag("EventEmbeddingError", error => recordEventError(counts, error))
      );
    },
    { discard: true }
  );
}

/**
 * Render each event into a document, reuse documents and vectors that already
 * exist, and embed the rest, `concurrency` requests at a time. Per-event
 * failures are counted and skipped; a FatalEmbeddingError stops the run.
 */
export function indexEvents(
  target: IndexTarget,
  events: readonly EventForEmbedding[],
  options: { batchSize: number; concurrency: number },
  counts: IndexCounts
): Effect.Effect<void, FatalEmbeddingError> {
  const { embeddingsDb, client, contentProfile, modelProfile } = target;
  // Documents already queued in this run, whose vectors may still be in flight.
  const queuedDocumentIds = new Set<number>();

  const prepare = (event: EventForEmbedding): Effect.Effect<PendingEmbedding | null> =>
    Effect.gen(function* () {
      const { renderedContent, document } = yield* Effect.try({
        try: () => {
          const renderedContent = renderEventLean(event);
          const document = upsertDocument(embeddingsDb, {
            sourceKind: "event",
            sourceKey: String(event.id),
            title: event.title,
            snippet: event.content?.slice(0, 240) ?? event.title,
            startTimestamp: event.timestamp,
            endTimestamp: event.end_timestamp ?? null,
            contentProfileId: contentProfile.id,
            contentProfileVersion: contentProfile.version,
            renderedContent,
            contentHash: contentHash(renderedContent),
            eventIds: [event.id],
          });
          return { renderedContent, document };
        },
        catch: cause => eventIndexingError(event.id, "prepare embedding document", cause),
      });
      counts[document.created ? "created" : "reused"]++;
      const vectorExists = yield* Effect.try({
        try: () => hasVector(embeddingsDb, document.id, modelProfile.id),
        catch: cause => eventIndexingError(event.id, "check existing vector", cause),
      });
      if (vectorExists || queuedDocumentIds.has(document.id)) {
        counts.skipped++;
        return null;
      }
      queuedDocumentIds.add(document.id);
      return { eventId: event.id, documentId: document.id, renderedContent, renderedBytes: Buffer.byteLength(renderedContent) };
    }).pipe(
      // A per-event failure skips that event and keeps indexing the rest.
      Effect.catchTag("EventEmbeddingError", error => recordEventError(counts, error).pipe(Effect.as(null)))
    );

  return Stream.fromIterable(events).pipe(
    Stream.mapEffect(prepare),
    Stream.filter((item): item is PendingEmbedding => item !== null),
    // Close a batch at batchSize documents or MAX_BATCH_BYTES, whichever comes first.
    Stream.transduce(
      Sink.foldWeighted({
        initial: Chunk.empty<PendingEmbedding>(),
        maxCost: MAX_BATCH_BYTES,
        cost: (batch, item) => (batch.length >= options.batchSize ? Number.POSITIVE_INFINITY : item.renderedBytes),
        body: (batch, item) => Chunk.append(batch, item),
      })
    ),
    // Up to `concurrency` requests are in flight, but results are emitted in
    // batch order, so vectors are written in event order. A FatalEmbeddingError
    // fails the stream and interrupts the requests still in flight.
    Stream.mapEffect(batch => embedBatch(client, Chunk.toReadonlyArray(batch)), { concurrency: options.concurrency }),
    Stream.runForEach(results => writeEmbeddingResults(embeddingsDb, modelProfile.id, results, counts))
  );
}

export interface CursorIndexOutcome {
  /** Events examined this run, whether embedded, reused, or skipped. */
  examined: number;
  lastEventId: number;
  caughtUp: boolean;
  /**
   * Corpus-source events past the cursor, 0 once caught up. It skips the
   * content check to stay an index-only count, so while catching up it also
   * includes empty events the cursor will pass without examining.
   */
  remainingQueueDepth: number;
}

/**
 * Index corpus events added since the stored cursor, in events.id order, until
 * none remain or `deadline` passes. The deadline is checked between steps, and
 * a step holds no more documents than one MAX_BATCH_BYTES batch per concurrent
 * request, so a run overruns its deadline by about one round of requests. The
 * cursor advances past a step only after every vector in it is written, so a
 * fatal error or interruption resumes from the last complete step. The cursor does pass events that failed individually,
 * and events that change in place keep their id and are not revisited; a full
 * `embeddings index` run picks up both.
 */
export function indexNewCorpusEvents(
  target: IndexTarget,
  timelineDb: Database,
  options: { batchSize: number; concurrency: number; deadline: number },
  counts: IndexCounts
): Effect.Effect<CursorIndexOutcome, FatalEmbeddingError> {
  const { embeddingsDb, contentProfile, modelProfile } = target;
  const eventsPerStep = options.concurrency * (MAX_BATCH_BYTES / MAX_RENDERED_BYTES);
  const where = buildCorpusWhere({ include: [], exclude: [] });
  const selectStep = timelineDb.prepare(
    `SELECT ${EVENT_FOR_EMBEDDING_COLUMNS} FROM events WHERE ${where.clause} AND id > ? ORDER BY id LIMIT ${eventsPerStep}`
  );
  const sourceWhere = buildCorpusSourceWhere({ include: [], exclude: [] });
  const countRemaining = timelineDb.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${sourceWhere.clause} AND id > ?`);
  return Effect.gen(function* () {
    let lastEventId = getIndexCursor(embeddingsDb, contentProfile.id, modelProfile.id);
    let examined = 0;
    const outcome = (caughtUp: boolean): CursorIndexOutcome => ({
      examined,
      lastEventId,
      caughtUp,
      remainingQueueDepth: caughtUp
        ? 0
        : (countRemaining.get(...sourceWhere.params, lastEventId) as { count: number }).count,
    });
    // Every run takes at least one step, so even a tiny budget makes progress.
    for (;;) {
      const events = selectStep.all(...where.params, lastEventId) as EventForEmbedding[];
      const last = events.at(-1);
      if (!last) return outcome(true);
      yield* indexEvents(target, events, options, counts);
      lastEventId = last.id;
      examined += events.length;
      setIndexCursor(embeddingsDb, contentProfile.id, modelProfile.id, lastEventId);
      if (events.length < eventsPerStep) return outcome(true);
      if (Date.now() >= options.deadline) return outcome(false);
    }
  });
}
