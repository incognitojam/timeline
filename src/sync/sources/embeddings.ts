import type { Database } from "bun:sqlite";
import { Effect, Either } from "effect";
import { loadConfig } from "../../config";
import { openReadonlyTimelineDb } from "../../db/readonly";
import { errorMessage } from "../../embeddings/client";
import { createEmbeddingClient, notConfiguredMessage, resolveEmbeddingProfile } from "../../embeddings/config";
import { EVENT_LEAN_PROFILE } from "../../embeddings/content";
import { ensureContentProfile, ensureModelProfile, getEmbeddingsDb, initEmbeddingsDb } from "../../embeddings/db";
import {
  ATTACHMENT_IMAGE_PROFILE,
  type ImageIndexCounts,
  type ImageIndexOutcome,
  indexNewImages,
} from "../../embeddings/images";
import {
  type CursorIndexOutcome,
  type IndexCounts,
  indexNewCorpusEvents,
  readEmbeddingBatchSize,
} from "../../embeddings/indexer";
import { DEFAULT_JOB_LEASE_MS } from "../../jobs/runner";
import { getMediaStore } from "../../media/storage";
import { NETWORK_GUARD_CONFIG_FIELDS } from "../network-guard";
import { POWER_GUARD_CONFIG_FIELDS } from "../power-guard";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

const SOURCE = "embeddings";

export const DEFAULT_EMBEDDINGS_TIME_BUDGET_MS = 60_000;
/** Half the job lease, leaving the rest for the last round of requests. */
export const MAX_EMBEDDINGS_TIME_BUDGET_MS = DEFAULT_JOB_LEASE_MS / 2;
export const DEFAULT_EMBEDDINGS_CONCURRENCY = 4;

export interface EmbeddingsSyncSettings {
  timeBudgetMs: number;
  concurrency: number;
  indexImages: boolean;
}

function positiveIntegerSetting(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER
): number | string {
  const value = config[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) return `invalid ${key} setting`;
  return value;
}

export function parseEmbeddingsSyncSettings(config: Record<string, unknown> = {}): EmbeddingsSyncSettings | string {
  const timeBudgetMs = positiveIntegerSetting(config, "time_budget_ms", DEFAULT_EMBEDDINGS_TIME_BUDGET_MS, MAX_EMBEDDINGS_TIME_BUDGET_MS);
  if (typeof timeBudgetMs === "string") return timeBudgetMs;
  const concurrency = positiveIntegerSetting(config, "concurrency", DEFAULT_EMBEDDINGS_CONCURRENCY);
  if (typeof concurrency === "string") return concurrency;
  const indexImages = config.index_images ?? false;
  if (typeof indexImages !== "boolean") return "invalid index_images setting";
  return { timeBudgetMs, concurrency, indexImages };
}

interface ImagePhase {
  counts: ImageIndexCounts;
  outcome: ImageIndexOutcome;
}

function failure(error: string, startedAt: number, metadata?: Record<string, unknown>): SyncResult {
  return {
    source: SOURCE,
    success: false,
    eventsAdded: 0,
    eventsUpdated: 0,
    error,
    durationMs: Date.now() - startedAt,
    metadata,
  };
}

export function embeddingsSyncResult(
  counts: IndexCounts,
  outcome: CursorIndexOutcome,
  startedAt: number,
  images?: ImagePhase
): SyncResult {
  const metadata = {
    ...counts,
    ...outcome,
    ...(images
      ? {
          images: { ...images.counts, remaining: images.outcome.remaining },
          remainingQueueDepth: outcome.remainingQueueDepth + images.outcome.remaining,
        }
      : {}),
  };
  const imageFailures = images?.counts.failed ?? 0;
  const errors = [
    // Failed events are passed by the cursor; a full `embeddings index` run retries them.
    ...(counts.errors > 0 ? [`${counts.errors} events failed to embed`] : []),
    // Failed images are recorded in embedding_failures and skipped by later runs.
    ...(imageFailures > 0 ? [`${imageFailures} images failed to embed`] : []),
  ];
  return {
    source: SOURCE,
    success: errors.length === 0,
    eventsAdded: counts.embedded + (images?.counts.embedded ?? 0),
    eventsUpdated: 0,
    ...(errors.length > 0 ? { error: `${errors.join(" and ")}; see the service log` } : {}),
    durationMs: Date.now() - startedAt,
    metadata,
  };
}

export const embeddingsSyncSource: SyncSource = {
  name: SOURCE,
  description: "Embed new events for semantic search",
  enabled: true,
  configSchema: [
    {
      key: "time_budget_ms",
      type: "number",
      label: "Time budget",
      description: "Maximum run time in milliseconds; other syncs wait while it runs",
      integer: true,
      min: 1,
      max: MAX_EMBEDDINGS_TIME_BUDGET_MS,
      default: DEFAULT_EMBEDDINGS_TIME_BUDGET_MS,
    },
    {
      key: "concurrency",
      type: "number",
      label: "Concurrent requests",
      description: "Embedding requests kept in flight; match the server's parallel slots",
      integer: true,
      min: 1,
      default: DEFAULT_EMBEDDINGS_CONCURRENCY,
    },
    {
      key: "index_images",
      type: "boolean",
      label: "Embed photos",
      description: "Also embed photos from searchable sources, fetching them from remote media storage when needed; needs llama-server started with --mmproj",
      default: false,
    },
    ...POWER_GUARD_CONFIG_FIELDS,
    ...NETWORK_GUARD_CONFIG_FIELDS,
  ],

  async canSync(config): Promise<string | null> {
    const settings = parseEmbeddingsSyncSettings(config);
    if (typeof settings === "string") return settings;
    return (await loadConfig()).embeddings ? null : notConfiguredMessage();
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startedAt = Date.now();
    const settings = parseEmbeddingsSyncSettings(options.config.sources[SOURCE]);
    if (typeof settings === "string") return failure(settings, startedAt);

    const counts: IndexCounts = { created: 0, reused: 0, embedded: 0, skipped: 0, errors: 0 };
    let imageCounts: ImageIndexCounts | undefined;
    let embeddingsDb: Database | undefined;
    let timelineDb: Database | undefined;
    try {
      const modelConfig = resolveEmbeddingProfile((await loadConfig()).embeddings);
      embeddingsDb = getEmbeddingsDb();
      initEmbeddingsDb(embeddingsDb);
      timelineDb = openReadonlyTimelineDb();
      const target = {
        embeddingsDb,
        client: createEmbeddingClient(modelConfig),
        contentProfile: ensureContentProfile(embeddingsDb, EVENT_LEAN_PROFILE),
        modelProfile: ensureModelProfile(embeddingsDb, modelConfig),
      };
      const deadline = startedAt + settings.timeBudgetMs;
      const outcome = await Effect.runPromise(
        indexNewCorpusEvents(
          target,
          timelineDb,
          { batchSize: readEmbeddingBatchSize(), concurrency: settings.concurrency, deadline },
          counts
        ).pipe(Effect.either),
        { signal: options.signal }
      );
      // A fatal error (dead provider, bad config) stops the run at the last complete cursor step.
      if (Either.isLeft(outcome)) return failure(outcome.left.message, startedAt, { ...counts });
      if (!settings.indexImages) return embeddingsSyncResult(counts, outcome.right, startedAt);

      // Photos take whatever budget the new events left.
      imageCounts = { embedded: 0, failed: 0 };
      const imageOutcome = await Effect.runPromise(
        indexNewImages(
          { ...target, contentProfile: ensureContentProfile(embeddingsDb, ATTACHMENT_IMAGE_PROFILE) },
          timelineDb,
          await getMediaStore(),
          { concurrency: settings.concurrency, deadline },
          imageCounts
        ).pipe(Effect.either),
        { signal: options.signal }
      );
      if (Either.isLeft(imageOutcome)) {
        return failure(imageOutcome.left.message, startedAt, { ...counts, images: { ...imageCounts } });
      }
      return embeddingsSyncResult(counts, outcome.right, startedAt, { counts: imageCounts, outcome: imageOutcome.right });
    } catch (error) {
      // Shutdown interrupts the run at the last complete cursor step; the next run resumes there.
      if (options.signal?.aborted) {
        return {
          source: SOURCE,
          success: true,
          eventsAdded: counts.embedded + (imageCounts?.embedded ?? 0),
          eventsUpdated: 0,
          durationMs: Date.now() - startedAt,
          metadata: { ...counts, ...(imageCounts ? { images: { ...imageCounts } } : {}), stoppedReason: "aborted" },
        };
      }
      return failure(errorMessage(error), startedAt, { ...counts, ...(imageCounts ? { images: { ...imageCounts } } : {}) });
    } finally {
      timelineDb?.close();
      embeddingsDb?.close();
    }
  },
};
