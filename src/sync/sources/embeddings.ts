import type { Database } from "bun:sqlite";
import { Effect, Result } from "effect";
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
  logEmbeddingRate,
  readEmbeddingBatchSize,
} from "../../embeddings/indexer";
import {
  conversationWindowProfile,
  indexConversationWindows,
  type WindowIndexCounts,
  type WindowIndexOutcome,
} from "../../embeddings/windows";
import { sourceIdsWithTraits } from "../../shared/sources";
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

const WINDOWS_OFF = "off";
/** Sources whose conversations can be windowed: searchable sources with conversation threads. */
const WINDOW_SOURCES = sourceIdsWithTraits(traits => traits.conversation !== undefined && traits.corpus !== undefined);

export interface EmbeddingsSyncSettings {
  timeBudgetMs: number;
  concurrency: number;
  indexImages: boolean;
  /** The one source whose conversations are also embedded as windows (a pilot), or null. */
  windowSource: string | null;
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
  const windowSource = config.conversation_windows ?? WINDOWS_OFF;
  if (typeof windowSource !== "string" || (windowSource !== WINDOWS_OFF && !WINDOW_SOURCES.includes(windowSource))) {
    return "invalid conversation_windows setting";
  }
  return { timeBudgetMs, concurrency, indexImages, windowSource: windowSource === WINDOWS_OFF ? null : windowSource };
}

interface ImagePhase {
  counts: ImageIndexCounts;
  outcome: ImageIndexOutcome;
}

interface WindowPhase {
  counts: WindowIndexCounts;
  outcome: WindowIndexOutcome;
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
  images?: ImagePhase,
  windows?: WindowPhase
): SyncResult {
  const metadata = {
    ...counts,
    ...outcome,
    ...(windows ? { windows: { ...windows.counts, ...windows.outcome } } : {}),
    ...(images
      ? {
          images: { ...images.counts, remaining: images.outcome.remaining },
          remainingQueueDepth: outcome.remainingQueueDepth + images.outcome.remaining,
        }
      : {}),
  };
  const imageFailures = images?.counts.failed ?? 0;
  const windowFailures = windows?.counts.errors ?? 0;
  const errors = [
    // Failed events are passed by the cursor; a full `embeddings index` run retries them.
    ...(counts.errors > 0 ? [`${counts.errors} events failed to embed`] : []),
    ...(windowFailures > 0 ? [`${windowFailures} conversation windows failed to embed`] : []),
    // Failed images are recorded in embedding_failures and skipped by later runs.
    ...(imageFailures > 0 ? [`${imageFailures} images failed to embed`] : []),
  ];
  return {
    source: SOURCE,
    success: errors.length === 0,
    eventsAdded: counts.embedded + (images?.counts.embedded ?? 0) + (windows?.counts.embedded ?? 0),
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
    {
      key: "conversation_windows",
      type: "select",
      label: "Conversation windows (pilot)",
      description: "Also embed this source's conversations as windows of consecutive messages, so search finds conversations about a topic as well as single messages",
      options: [WINDOWS_OFF, ...WINDOW_SOURCES],
      default: WINDOWS_OFF,
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

    const counts: IndexCounts = { created: 0, reused: 0, embedded: 0, skipped: 0, errors: 0, embeddedBytes: 0 };
    let imageCounts: ImageIndexCounts | undefined;
    let windows: WindowPhase | undefined;
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
        ).pipe(Effect.result),
        { signal: options.signal }
      );
      // A fatal error (dead provider, bad config) stops the run at the last complete cursor step.
      if (Result.isFailure(outcome)) return failure(outcome.failure.message, startedAt, { ...counts });
      logEmbeddingRate("embeddings", counts.embedded, counts.embeddedBytes, startedAt);

      if (settings.windowSource) {
        // Windows take whatever budget the new events left, before photos.
        const windowsStartedAt = Date.now();
        const windowCounts: WindowIndexCounts = { windows: 0, embedded: 0, embeddedBytes: 0, reused: 0, removed: 0, errors: 0 };
        const windowOutcome = await Effect.runPromise(
          indexConversationWindows(
            { ...target, contentProfile: ensureContentProfile(embeddingsDb, conversationWindowProfile(settings.windowSource)) },
            timelineDb,
            {
              source: settings.windowSource,
              batchSize: readEmbeddingBatchSize(),
              concurrency: settings.concurrency,
              deadline,
            },
            windowCounts
          ).pipe(Effect.result),
          { signal: options.signal }
        );
        if (Result.isFailure(windowOutcome)) {
          return failure(windowOutcome.failure.message, startedAt, { ...counts, windows: { ...windowCounts } });
        }
        logEmbeddingRate(`embeddings windows ${settings.windowSource}`, windowCounts.embedded, windowCounts.embeddedBytes, windowsStartedAt);
        windows = { counts: windowCounts, outcome: windowOutcome.success };
      }
      if (!settings.indexImages) return embeddingsSyncResult(counts, outcome.success, startedAt, undefined, windows);

      // Photos take whatever budget the new events left.
      imageCounts = { embedded: 0, failed: 0 };
      const imageOutcome = await Effect.runPromise(
        indexNewImages(
          { ...target, contentProfile: ensureContentProfile(embeddingsDb, ATTACHMENT_IMAGE_PROFILE) },
          timelineDb,
          await getMediaStore(),
          { concurrency: settings.concurrency, deadline },
          imageCounts
        ).pipe(Effect.result),
        { signal: options.signal }
      );
      if (Result.isFailure(imageOutcome)) {
        return failure(imageOutcome.failure.message, startedAt, { ...counts, images: { ...imageCounts } });
      }
      return embeddingsSyncResult(
        counts,
        outcome.success,
        startedAt,
        { counts: imageCounts, outcome: imageOutcome.success },
        windows
      );
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
