import { Database } from "bun:sqlite";
import { loadConfig } from "../../config";
import { MAX_TIMEOUT_DELAY_MS, type LlmConfig } from "../../config/types";
import { getDb, initDb } from "../../db/schema";
import { runLocalWork } from "../../jobs/local-work";
import {
  getVisionAvailability,
  initProviders,
  resolveLanguageModel,
  type VisionAvailability,
} from "../../llm";
import {
  type DescribeStats,
  countDescriptionEligibleHashes,
  countNeedingDescriptions,
  describeAttachments,
  selectAttachmentsToDescribe,
} from "../../media/describe-attachments";
import { getMediaStore } from "../../media/storage";
import { isAttachmentDescriptionImageDimension, MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION } from "../../shared/attachments";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

export interface AttachmentDescriptionsSettings {
  models: string[];
  reasoningEffort?: string;
  maxImageDimension?: number;
  timeBudgetMs: number;
  limit?: number;
}

export interface AttachmentDescriptionModelWarning {
  model: string;
  availability: "not-vision";
  message: string;
}

export type AttachmentDescriptionModelSelection =
  | { status: "selected"; model: string; warnings: AttachmentDescriptionModelWarning[] }
  | { status: "unavailable"; warnings: AttachmentDescriptionModelWarning[] }
  | { status: "not-vision"; warnings: AttachmentDescriptionModelWarning[] };

export const DEFAULT_ATTACHMENT_DESCRIPTION_TIME_BUDGET_MS = 5 * 60_000;
export const DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT = 500;

function parsePreferredModels(config: Record<string, unknown>): string[] | string {
  if (config.models !== undefined) {
    if (
      !Array.isArray(config.models) ||
      config.models.length === 0 ||
      config.models.some((model) => typeof model !== "string" || !model.trim())
    ) {
      return "invalid models setting";
    }
    return config.models.map((model) => (model as string).trim());
  }
  if (typeof config.model === "string" && config.model.trim()) return [config.model.trim()];
  return "not configured: models is required";
}

export function parseAttachmentDescriptionsSettings(
  config: Record<string, unknown> = {},
): AttachmentDescriptionsSettings | string {
  const models = parsePreferredModels(config);
  if (typeof models === "string") return models;
  if (config.reasoning_effort !== undefined && typeof config.reasoning_effort !== "string") {
    return "invalid reasoning_effort setting";
  }
  if (config.max_image_dimension !== undefined && !isAttachmentDescriptionImageDimension(config.max_image_dimension)) {
    return `max_image_dimension must be an integer between 1 and ${MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION}`;
  }
  if (
    config.time_budget_ms !== undefined &&
    (typeof config.time_budget_ms !== "number" ||
      !Number.isFinite(config.time_budget_ms) ||
      config.time_budget_ms <= 0)
  ) {
    return "invalid time_budget_ms setting";
  }
  if (
    config.limit !== undefined &&
    (typeof config.limit !== "number" || !Number.isInteger(config.limit) || config.limit <= 0)
  ) {
    return "invalid limit setting";
  }
  return {
    models,
    reasoningEffort: config.reasoning_effort as string | undefined,
    maxImageDimension: config.max_image_dimension,
    timeBudgetMs:
      (config.time_budget_ms as number | undefined) ??
      DEFAULT_ATTACHMENT_DESCRIPTION_TIME_BUDGET_MS,
    limit: config.limit as number | undefined,
  };
}

export function attachmentDescriptionModelRefs(
  config?: Record<string, unknown>,
): string[] | null {
  const settings = parseAttachmentDescriptionsSettings(config);
  return typeof settings === "string" ? null : settings.models;
}

/** Read the configured model order used when selecting a stored description. */
export function getConfiguredAttachmentDescriptionModels(db: Database): string[] | undefined {
  try {
    const row = db.prepare(
      "SELECT settings FROM sync_sources WHERE source = 'attachment-descriptions'",
    ).get() as { settings: string } | null;
    if (!row) return undefined;

    const config = JSON.parse(row.settings) as Record<string, unknown>;
    const settings = parseAttachmentDescriptionsSettings(config);
    return typeof settings === "string" ? undefined : settings.models;
  } catch {
    return undefined;
  }
}

export function selectAttachmentsForDescriptionRun(
  db: Database,
  settings: AttachmentDescriptionsSettings,
) {
  return selectAttachmentsToDescribe(db, {
    limit: settings.limit ?? DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT,
    newest: true,
    excludeDescribedBy: "any",
  });
}

export async function selectAttachmentDescriptionModel(
  llmConfig: LlmConfig,
  models: string[],
  getAvailability: (
    config: LlmConfig,
    ref: string,
  ) => Promise<VisionAvailability> = getVisionAvailability,
): Promise<AttachmentDescriptionModelSelection> {
  const warnings: AttachmentDescriptionModelWarning[] = [];
  for (const model of models) {
    const availability = await getAvailability(llmConfig, model);
    if (availability === "available" || availability === "unknown") {
      return { status: "selected", model, warnings };
    }
    if (availability === "not-vision") {
      warnings.push({
        model,
        availability,
        message: `Configured model ${model} is not vision-capable`,
      });
    }
  }
  return warnings.length > 0
    ? { status: "not-vision", warnings }
    : { status: "unavailable", warnings };
}

export function attachmentDescriptionAllUnavailableFailure(
  models: string[],
  startedAt: number,
): SyncResult {
  return {
    source: "attachment-descriptions",
    success: false,
    eventsAdded: 0,
    eventsUpdated: 0,
    error: `Configured attachment description models are unavailable: ${models.join(", ")}`,
    durationMs: Date.now() - startedAt,
  };
}

export function attachmentDescriptionNotVisionResult(
  warnings: AttachmentDescriptionModelWarning[],
  startedAt: number,
): SyncResult {
  return {
    source: "attachment-descriptions",
    success: false,
    eventsAdded: 0,
    eventsUpdated: 0,
    error: `No configured attachment description model is vision-capable: ${warnings.map(({ model }) => model).join(", ")}`,
    durationMs: Date.now() - startedAt,
    metadata: { modelWarnings: warnings },
  };
}

export function attachmentDescriptionSyncResult(
  db: Database | undefined,
  settings: AttachmentDescriptionsSettings,
  stats: DescribeStats,
  startedAt: number,
  model: string,
  modelWarnings: AttachmentDescriptionModelWarning[],
): SyncResult {
  const failureSamples = stats.failureSamples ?? [];
  const omittedFailureSamples = Math.max(0, stats.failed - failureSamples.length);
  const queueCounts = db ? (() => {
    const descriptionEligibleHashes = countDescriptionEligibleHashes(db);
    const remainingQueueDepth = countNeedingDescriptions(db);
    return { remainingQueueDepth, descriptionEligibleHashes, describedHashes: descriptionEligibleHashes - remainingQueueDepth };
  })() : {};
  const metadata = {
    described: stats.described,
    skipped: stats.skipped,
    failed: stats.failed,
    model,
    ...queueCounts,
    ...(stats.stoppedReason ? { stoppedReason: stats.stoppedReason } : {}),
    ...(failureSamples.length > 0 ? { failureSamples } : {}),
    ...(omittedFailureSamples > 0 ? { omittedFailureSamples } : {}),
    ...(modelWarnings.length > 0 ? { modelWarnings } : {}),
  };
  if (stats.stoppedReason === "model-unavailable" || stats.stoppedReason === "consecutive-failures") {
    const error = stats.stoppedReason === "model-unavailable"
      ? "Attachment description model became unavailable"
      : "Attachment description stopped after consecutive failures";
    return {
      source: "attachment-descriptions",
      success: false,
      eventsAdded: stats.described,
      eventsUpdated: 0,
      error: `${error}: ${stats.firstFailure ?? "unknown error"}`,
      durationMs: Date.now() - startedAt,
      metadata,
    };
  }
  if (stats.described === 0 && stats.failed > 0) {
    return {
      source: "attachment-descriptions",
      success: false,
      eventsAdded: 0,
      eventsUpdated: 0,
      error: `All attachment description attempts failed: ${stats.firstFailure ?? "unknown error"}`,
      durationMs: Date.now() - startedAt,
      metadata,
    };
  }
  return {
    source: "attachment-descriptions",
    success: true,
    eventsAdded: stats.described,
    eventsUpdated: 0,
    durationMs: Date.now() - startedAt,
    metadata,
  };
}

export const attachmentDescriptionsSyncSource: SyncSource = {
  name: "attachment-descriptions",
  description: "Generate AI descriptions for new image attachments",
  enabled: true,
  configSchema: [
    {
      key: "models",
      type: "string-list",
      label: "Models",
      description: "Language models in preference order; later entries are fallbacks",
      required: true,
    },
    {
      key: "reasoning_effort",
      type: "string",
      label: "Reasoning effort",
      description: "Reasoning effort passed to the language model",
    },
    {
      key: "max_image_dimension",
      type: "number",
      label: "Maximum image dimension",
      description: "Longest image side in pixels sent to any selected model. Try 1024 if larger inputs fail; stored originals are unchanged.",
      integer: true,
      min: 1,
      max: MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION,
      default: MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION,
    },
    {
      key: "time_budget_ms",
      type: "number",
      label: "Time budget",
      description: "Maximum run time in milliseconds",
      integer: true,
      min: 1,
      max: MAX_TIMEOUT_DELAY_MS,
      default: DEFAULT_ATTACHMENT_DESCRIPTION_TIME_BUDGET_MS,
    },
    {
      key: "limit",
      type: "number",
      label: "Attachment limit",
      description: "Maximum number of attachments considered per run",
      integer: true,
      min: 1,
      default: DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT,
    },
  ],

  async canSync(config): Promise<string | null> {
    const settings = parseAttachmentDescriptionsSettings(config);
    return typeof settings === "string" ? settings : null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startedAt = Date.now();
    const settings = parseAttachmentDescriptionsSettings(options.config.sources["attachment-descriptions"]);
    if (typeof settings === "string") {
      return {
        source: "attachment-descriptions",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: settings,
        durationMs: 0,
      };
    }
    let openedDb: Database | undefined;
    let progressResult: SyncResult | undefined;
    try {
      const { db, deadline } = await runLocalWork(options.localWork, options.signal, () => {
        const deadline = Date.now() + settings.timeBudgetMs;
        const db = getDb();
        openedDb = db;
        initDb(db);
        return { db, deadline };
      });
      const config = await loadConfig();
      const selection = await selectAttachmentDescriptionModel(config.llm, settings.models);
      if (selection.status === "unavailable") {
        // Scheduled runs are deferred by visionGuard before reaching sync. This only
        // occurs for a forced manual run or an availability race, both of which need
        // an honest failure record.
        return attachmentDescriptionAllUnavailableFailure(settings.models, startedAt);
      }
      if (selection.status === "not-vision") {
        return attachmentDescriptionNotVisionResult(selection.warnings, startedAt);
      }
      await initProviders(config.llm);
      const { candidates, mediaStore } = await runLocalWork(options.localWork, options.signal, async () => ({
        candidates: selectAttachmentsForDescriptionRun(db, settings),
        mediaStore: await getMediaStore(),
      }));
      const stats = await describeAttachments({
        db,
        mediaStore,
        languageModel: resolveLanguageModel(selection.model),
        modelRef: selection.model,
        candidates,
        reasoningEffort: settings.reasoningEffort,
        maxImageDimension: settings.maxImageDimension,
        signal: options.signal,
        localWork: options.localWork,
        deadline,
      });
      // Keep observed progress even if cancellation prevents fresh queue counts.
      progressResult = attachmentDescriptionSyncResult(undefined, settings, stats, startedAt, selection.model, selection.warnings);
      return await runLocalWork(options.localWork, options.signal, () => attachmentDescriptionSyncResult(
        db,
        settings,
        stats,
        startedAt,
        selection.model,
        selection.warnings,
      ));
    } catch (error) {
      return {
        source: "attachment-descriptions",
        eventsAdded: 0,
        eventsUpdated: 0,
        ...progressResult,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      openedDb?.close();
    }
  },
};
