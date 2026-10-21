import type { Database } from "bun:sqlite";
import { APICallError } from "@ai-sdk/provider";
import { generateText, type LanguageModel, RetryError } from "ai";
import sharp from "sharp";
import type { QueryExecutor } from "../db/pool";
import { type LocalWorkGate, runLocalWork } from "../jobs/local-work";
import { isAttachmentDescriptionImageDimension, MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION } from "../shared/attachments";
import { NOISY_MACHINE_SOURCES } from "../shared/noisy-sources";
import type { getMediaStore } from "./storage";

const INSTRUCTION = "Write a brief, factual description of this image. Transcribe prominent visible text, and name the visible objects, setting, and activity. Do not speculate about the identities of people. Reply with the description only — plain prose, no headings, lists, or preamble.";

export interface DescribeAttachmentsOptions {
  model: string;
  limit?: number;
  source?: string;
  reasoningEffort?: string;
  newest?: boolean;
  /** Whether existing descriptions are scoped to one model or all models. */
  excludeDescribedBy?: "model" | "any";
}

export interface AttachmentDescriptionCandidate {
  content_hash: string;
  source: string;
  filename: string | null;
  storage_path: string | null;
  mime_type: string;
}

export interface AttachmentDescriptionFailureSample {
  contentHash: string;
  source: string;
  filename: string | null;
  durationMs: number;
  error: {
    name: string;
    message: string;
  };
}

export interface DescribeStats {
  described: number;
  skipped: number;
  failed: number;
  remaining: number;
  firstFailure?: string;
  stoppedReason?: "time-budget" | "model-unavailable" | "consecutive-failures";
  failureSamples?: AttachmentDescriptionFailureSample[];
}

export const ATTACHMENT_DESCRIPTION_FAILURE_SAMPLE_LIMIT = 10;
// LM Studio rejects image data URLs in any other format with a 400
// ("'url' field must be a base64 encoded image"), so everything else —
// notably recall's WebP captures — is re-encoded before sending.
const MODEL_INPUT_MEDIA_TYPES = new Set(["image/png", "image/jpeg"]);

type AttachmentDescriptionSelection = Omit<
  Pick<DescribeAttachmentsOptions, "model" | "limit" | "source" | "newest" | "excludeDescribedBy">,
  "model"
> & { model?: string };

function attachmentColumn(tableAlias: string, column: string): string {
  return tableAlias ? `${tableAlias}.${column}` : column;
}

/** Conditions on shape alone (mime, hash) that make an attachment describable, regardless of status. */
export function describableAttachmentFilters(tableAlias = "attachments"): string[] {
  return [
    `${attachmentColumn(tableAlias, "mime_type")} LIKE 'image/%'`,
    `${attachmentColumn(tableAlias, "content_hash")} IS NOT NULL`,
  ];
}

/** Conditions that define an attachment eligible for image description. */
export function attachmentDescriptionEligibilityFilters(tableAlias = "attachments"): string[] {
  return [
    `${attachmentColumn(tableAlias, "status")} = 'stored'`,
    ...describableAttachmentFilters(tableAlias),
  ];
}

/** Conditions that define the default scheduled image-description corpus. */
export function scheduledAttachmentDescriptionEligibilityFilters(tableAlias = "attachments"): string[] {
  const excludedSources = NOISY_MACHINE_SOURCES.map((source) => `'${source}'`).join(", ");
  return [
    ...attachmentDescriptionEligibilityFilters(tableAlias),
    `${attachmentColumn(tableAlias, "source")} NOT IN (${excludedSources})`,
  ];
}

export function attachmentDescriptionFilters(
  options: AttachmentDescriptionSelection,
  tableAlias = "attachments",
): {
  filters: string[];
  params: Array<string | number>;
} {
  const contentHash = attachmentColumn(tableAlias, "content_hash");
  const source = attachmentColumn(tableAlias, "source");
  const filters = options.source
    ? attachmentDescriptionEligibilityFilters(tableAlias)
    : scheduledAttachmentDescriptionEligibilityFilters(tableAlias);
  const params: Array<string | number> = [];
  if (options.excludeDescribedBy === "any") {
    filters.push(`NOT EXISTS (
      SELECT 1
      FROM attachment_descriptions ad
      WHERE ad.content_hash = ${contentHash}
    )`);
  } else {
    if (!options.model) throw new Error("model is required when excluding descriptions by model");
    filters.push(`NOT EXISTS (
      SELECT 1
      FROM attachment_descriptions ad
      WHERE ad.content_hash = ${contentHash}
        AND ad.model = ?
    )`);
    params.push(options.model);
  }
  if (options.source) {
    filters.push(`${source} = ?`);
    params.push(options.source);
  }
  return { filters, params };
}

function needingDescriptionsQuery(): { sql: string; params: Array<string | number> } {
  const { filters, params } = attachmentDescriptionFilters({ excludeDescribedBy: "any" });
  return {
    sql: `
    SELECT COUNT(DISTINCT content_hash) AS count
    FROM attachments
    WHERE ${filters.join(" AND ")}
  `,
    params,
  };
}

function descriptionEligibleHashesQuery(): string {
  return `
    SELECT COUNT(DISTINCT content_hash) AS count
    FROM attachments
    WHERE ${scheduledAttachmentDescriptionEligibilityFilters().join(" AND ")}
  `;
}

/** Count distinct stored images in the default scheduled-description corpus. */
export function countDescriptionEligibleHashes(db: Database): number;
export function countDescriptionEligibleHashes(db: QueryExecutor): Promise<number>;
export function countDescriptionEligibleHashes(db: Database | QueryExecutor): number | Promise<number> {
  const sql = descriptionEligibleHashesQuery();
  if ("get" in db) {
    return db.get<{ count: number }>(sql).then((row) => {
      if (!row) throw new Error("Attachment description eligibility count query returned no result");
      return row.count;
    });
  }
  const row = db.prepare(sql).get() as { count: number } | null;
  if (!row) throw new Error("Attachment description eligibility count query returned no result");
  return row.count;
}

/** Count distinct stored images that have no description from any model. */
export function countNeedingDescriptions(db: Database): number;
export function countNeedingDescriptions(db: QueryExecutor): Promise<number>;
export function countNeedingDescriptions(db: Database | QueryExecutor): number | Promise<number> {
  const { sql, params } = needingDescriptionsQuery();
  if ("get" in db) {
    return db.get<{ count: number }>(sql, ...params).then((row) => {
      if (!row) throw new Error("Attachment description count query returned no result");
      return row.count;
    });
  }
  const row = db.prepare(sql).get(...params) as { count: number } | null;
  if (!row) throw new Error("Attachment description count query returned no result");
  return row.count;
}

export function selectAttachmentsToDescribe(
  db: Database,
  options: AttachmentDescriptionSelection,
): AttachmentDescriptionCandidate[] {
  const { filters, params } = attachmentDescriptionFilters(options);

  const limitSql = options.limit ? "LIMIT ?" : "";
  if (options.limit) params.push(options.limit);

  const aggregate = options.newest ? "MAX" : "MIN";
  const direction = options.newest ? "DESC" : "ASC";
  return db.prepare(`
    SELECT
      a.content_hash,
      a.source,
      a.filename,
      a.storage_path,
      a.mime_type
    FROM (
      SELECT ${aggregate}(id) AS id
      FROM attachments
      WHERE ${filters.join(" AND ")}
      GROUP BY content_hash
      ORDER BY ${aggregate}(id) ${direction}
      ${limitSql}
    ) picked
    JOIN attachments a ON a.id = picked.id
    ORDER BY a.id ${direction}
  `).all(...params) as AttachmentDescriptionCandidate[];
}

function displayName(candidate: AttachmentDescriptionCandidate): string {
  return candidate.filename || candidate.storage_path || "(unnamed)";
}

function providerOptionsFor(reasoningEffort: string | undefined) {
  if (!reasoningEffort) return undefined;
  return { openaiCompatible: { reasoningEffort } };
}

function descriptionAbortSignals(signal: AbortSignal | undefined, deadline: number | undefined): {
  abortSignal?: AbortSignal;
  deadlineSignal?: AbortSignal;
} {
  const deadlineSignal = deadline !== undefined
    ? AbortSignal.timeout(Math.max(0, deadline - Date.now()))
    : undefined;
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (deadlineSignal) signals.push(deadlineSignal);
  return {
    abortSignal: signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals),
    deadlineSignal,
  };
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
    };
  }
  return { name: "Error", message: String(error) };
}

function deadlineCausedAbort(signals: {
  abortSignal?: AbortSignal;
  deadlineSignal?: AbortSignal;
}): boolean {
  return signals.abortSignal?.aborted === true &&
    signals.deadlineSignal?.aborted === true &&
    signals.abortSignal.reason === signals.deadlineSignal.reason;
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ConnectionClosed",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

function unwrapErrors(error: unknown): unknown[] {
  const seen = new Set<unknown>();
  const pending = [error];
  const unwrapped: unknown[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    unwrapped.push(current);
    const candidate = current as { cause?: unknown };
    if (candidate.cause) pending.push(candidate.cause);
    if (RetryError.isInstance(current)) {
      pending.push(current.lastError, ...current.errors);
    }
  }
  return unwrapped;
}

function isConnectionError(error: unknown): boolean {
  return unwrapErrors(error).some((current) => {
    const candidate = current as { code?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && CONNECTION_ERROR_CODES.has(candidate.code)) {
      return true;
    }
    if (typeof candidate.message === "string" && /\b(?:fetch failed|failed to fetch|cannot connect to (?:the )?api)\b/iu.test(candidate.message)) {
      return true;
    }
    return false;
  });
}

function isModelUnavailableError(error: unknown): boolean {
  if (isConnectionError(error)) return true;
  return unwrapErrors(error).some((current) => {
    if (!APICallError.isInstance(current)) return false;
    const details = [current.message, current.responseBody]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    return /\bno\s+models?\s+(?:are\s+)?(?:currently\s+)?loaded\b/iu.test(details);
  });
}

export async function prepareAttachmentImageForDescription(
  image: Buffer,
  mediaType: string,
  maxImageDimension = MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION,
): Promise<{ image: Buffer; mediaType: string }> {
  if (!isAttachmentDescriptionImageDimension(maxImageDimension)) {
    throw new Error(`maxImageDimension must be an integer between 1 and ${MAX_ATTACHMENT_DESCRIPTION_IMAGE_DIMENSION}`);
  }
  const source = sharp(image);
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Could not determine attachment image dimensions");
  }
  const withinLimit = Math.max(metadata.width, metadata.height) <= maxImageDimension;
  if (withinLimit && MODEL_INPUT_MEDIA_TYPES.has(mediaType)) {
    return { image, mediaType };
  }

  // Sharp uses the first frame of animated GIFs by default, which is acceptable
  // here because animated inputs are only ever sent as a single still.
  const transformed = source.rotate().resize(maxImageDimension, maxImageDimension, {
    fit: "inside",
    withoutEnlargement: true,
  });
  if (metadata.format === "jpeg") {
    return { image: await transformed.jpeg().toBuffer(), mediaType: "image/jpeg" };
  }
  return { image: await transformed.png().toBuffer(), mediaType: "image/png" };
}

export async function generateAttachmentDescription(options: {
  model: LanguageModel;
  image: Buffer;
  mediaType: string;
  reasoningEffort?: string;
  maxImageDimension?: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const image = await prepareAttachmentImageForDescription(options.image, options.mediaType, options.maxImageDimension);
  options.abortSignal?.throwIfAborted();
  const result = await generateText({
    model: options.model,
    abortSignal: options.abortSignal,
    providerOptions: providerOptionsFor(options.reasoningEffort),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: INSTRUCTION },
          {
            type: "file",
            data: image.image,
            mediaType: image.mediaType,
          },
        ],
      },
    ],
  });
  return result.text.trim();
}

function stopDescriptionRun(
  options: { signal?: AbortSignal; deadline?: number },
  stats: DescribeStats,
  remaining: number,
): boolean {
  if (options.signal?.aborted) {
    stats.remaining = remaining;
    return true;
  }
  if (options.deadline !== undefined && Date.now() >= options.deadline) {
    stats.remaining = remaining;
    stats.stoppedReason = "time-budget";
    return true;
  }
  return false;
}

export async function describeAttachments(options: {
  db: Database;
  mediaStore: Awaited<ReturnType<typeof getMediaStore>>;
  languageModel: LanguageModel;
  modelRef: string;
  candidates?: AttachmentDescriptionCandidate[];
  selection?: Pick<DescribeAttachmentsOptions, "limit" | "source" | "newest">;
  reasoningEffort?: string;
  maxImageDimension?: number;
  signal?: AbortSignal;
  deadline?: number;
  localWork?: LocalWorkGate;
}): Promise<DescribeStats> {
  const { candidates, insert } = await runLocalWork(options.localWork, options.signal, () => ({
    candidates: options.candidates ?? selectAttachmentsToDescribe(options.db, {
      model: options.modelRef,
      ...options.selection,
    }),
    insert: options.db.prepare(`
      INSERT OR REPLACE INTO attachment_descriptions (content_hash, model, description, duration_ms)
      VALUES (?, ?, ?, ?)
    `),
  }));

  const stats: DescribeStats = {
    described: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    failureSamples: [],
  };
  let consecutiveFailures = 0;
  for (let index = 0; index < candidates.length; index++) {
    if (stopDescriptionRun(options, stats, candidates.length - index)) break;
    const candidate = candidates[index];
    let started = Date.now();
    const label = `${candidate.content_hash.slice(0, 12)} ${candidate.source} ${displayName(candidate)}`;
    const abortSignals = descriptionAbortSignals(options.signal, options.deadline);
    try {
      if (!candidate.storage_path) {
        stats.skipped++;
        console.warn(`skip ${label}: missing storage_path`);
        continue;
      }

      const storagePath = candidate.storage_path;
      const file = await runLocalWork(options.localWork, abortSignals.abortSignal, async () => {
        if (stopDescriptionRun(options, stats, candidates.length - index)) return null;
        // Model comparisons include media preparation, but not scheduler waits.
        started = Date.now();
        const stored = await options.mediaStore.readFile(storagePath);
        if (stopDescriptionRun(options, stats, candidates.length - index)) return null;
        return stored ?? await options.mediaStore.restoreFromRemote(storagePath, candidate.content_hash);
      });
      options.signal?.throwIfAborted();
      if (stopDescriptionRun(options, stats, candidates.length - index)) break;
      if (!file) {
        stats.skipped++;
        console.warn(`skip ${label}: media file is missing`);
        continue;
      }

      const description = await generateAttachmentDescription({
        model: options.languageModel,
        image: Buffer.from(file.content),
        mediaType: candidate.mime_type,
        reasoningEffort: options.reasoningEffort,
        maxImageDimension: options.maxImageDimension,
        abortSignal: abortSignals.abortSignal,
      });
      options.signal?.throwIfAborted();
      if (!description) {
        stats.skipped++;
        console.warn(`skip ${label}: model returned an empty description`);
        continue;
      }

      // Only explicit cancellation cancels persistence. A result completed
      // within budget must survive a wait for an importer's local-work permit.
      const durationMs = Date.now() - started;
      await runLocalWork(options.localWork, options.signal, () => {
        insert.run(candidate.content_hash, options.modelRef, description, durationMs);
      });
      stats.described++;
      consecutiveFailures = 0;
      console.log(`described ${label} ${durationMs}ms`);
    } catch (error) {
      if (options.signal?.aborted) {
        stats.remaining = candidates.length - index;
        break;
      }
      if (deadlineCausedAbort(abortSignals)) {
        stats.remaining = candidates.length - index;
        stats.stoppedReason = "time-budget";
        break;
      }

      const durationMs = Date.now() - started;
      const normalizedError = normalizeError(error);
      stats.failed++;
      consecutiveFailures++;
      if (!stats.firstFailure) {
        stats.firstFailure = normalizedError.message;
      }
      if ((stats.failureSamples?.length ?? 0) < ATTACHMENT_DESCRIPTION_FAILURE_SAMPLE_LIMIT) {
        stats.failureSamples?.push({
          contentHash: candidate.content_hash,
          source: candidate.source,
          filename: candidate.filename,
          durationMs,
          error: normalizedError,
        });
      }
      console.error(
        `failed ${label} ${durationMs}ms: ${normalizedError.name}: ${normalizedError.message}`,
      );
      if (isModelUnavailableError(error)) {
        stats.remaining = candidates.length - index - 1;
        stats.stoppedReason = "model-unavailable";
        break;
      }
      if (consecutiveFailures >= 5) {
        stats.remaining = candidates.length - index - 1;
        stats.stoppedReason = "consecutive-failures";
        break;
      }
    }
  }
  return stats;
}
