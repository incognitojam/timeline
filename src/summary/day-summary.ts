import type { Database } from "bun:sqlite";
import {
  type LanguageModel,
  type LanguageModelUsage,
  type ProviderMetadata,
  generateText,
  streamText,
} from "ai";
import { getEvents } from "../db/queries";
import type { QueryExecutor } from "../db/pool";
import { renderEvents, groupEvents, renderEventGroup } from "../export/render";
import { loadReplyQuotesForEvents, type ReplyQuotesByEvent } from "../export/reply-quotes";
import { countTokens } from "../export/tokens";
import {
  getCachedDaySummary,
  saveDaySummary,
  type DaySummary,
} from "../db/app-state";
import type { TimelineEvent } from "../db/schema";
import { getContextLength, getDefaultModel, resolveLanguageModel } from "../llm";

/**
 * Sources excluded from LLM contexts built from a day's events
 * (day summaries, journal questions, and the cited-group rebuild).
 * - recall: screen captures dump frontmost-app names with no useful narrative
 *   context (and OCR text would explode the token count further).
 * - spotify-friends / steam-friends: other people's activity, not the user's day.
 *   steam-friends no longer syncs, but databases keep its existing events.
 */
export const SUMMARY_EXCLUDED_SOURCES = new Set(["recall", "spotify-friends", "steam-friends"]);

/**
 * Calculate token threshold based on model context window.
 * Uses formula: 10 * (context ^ 0.75) which gives:
 * - 131K context → ~72K threshold
 * - 262K context → ~122K threshold
 * - 400K context → ~160K threshold
 * - 1M context → ~316K threshold
 */
function getTokenThreshold(model: string): number {
  const contextWindow = getContextLength(model);
  return Math.floor(10 * Math.pow(contextWindow, 0.75));
}

export interface DaySummaryOptions {
  date: string; // YYYY-MM-DD
  model?: string; // OpenRouter model ID (e.g., "anthropic/claude-3-haiku")
  forceRegenerate?: boolean;
}

export interface SummaryMetadata {
  inputTokens: number;
  outputTokens: number;
  /**
   * Portion of outputTokens spent on hidden reasoning (reasoning models emit
   * far more tokens than the visible summary — this makes that legible). Omitted
   * for non-reasoning models.
   */
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  generationMs: number;
  finishReason?: string;
}

export interface DaySummaryResult {
  date: string;
  summary: string;
  tokenCount: number; // Input tokens used
  eventCount: number;
  model: string;
  cached: boolean;
  metadata: SummaryMetadata | null;
}

function openRouterCost(providerMetadata: ProviderMetadata | undefined): number | undefined {
  const metadata = providerMetadata?.openrouter;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const usage = metadata.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  return typeof usage.cost === "number" ? usage.cost : undefined;
}

function extractUsage(
  usage: LanguageModelUsage,
  providerMetadata: ProviderMetadata | undefined,
  finishReason: string,
): SummaryMetadata {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? undefined,
    cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? undefined,
    cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? undefined,
    cost: openRouterCost(providerMetadata),
    generationMs: 0,
    finishReason,
  };
}

function mergeUsage(a: SummaryMetadata, b: SummaryMetadata): SummaryMetadata {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) || undefined,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) || undefined,
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) || undefined,
    cost: (a.cost ?? 0) + (b.cost ?? 0) || undefined,
    generationMs: 0,
  };
}

/**
 * Build the prompt for summarizing a day
 */
function buildDaySummaryPrompt(date: string, renderedEvents: string, eventCount: number): string {
  return `Create a detailed journal entry for ${date} from this personal timeline data.

IMPORTANT: Include direct quotes from messages. For example:
- Alice said "the new office is huge, there are five floors"
- In the group chat, Bob joked "imagine paying extra for ketchup"

Structure your response with these sections:

**Morning** (before 12pm)
What happened, where, with whom. Include timestamps.

**Afternoon** (12pm-6pm)
What happened, where, with whom. Include timestamps.

**Evening** (after 6pm)
What happened, where, with whom. Include timestamps.

**Key Conversations**
For EACH conversation/chat, write a paragraph covering:
- Who was involved and what time
- Main topics discussed (be specific - not "various things" but actual topics)
- 2-3 direct quotes from the messages that are interesting, funny, or capture the mood
- Any plans made, arguments, jokes, or notable moments

**Music & Media**
What was listened to/watched, any patterns.

**Other Notable Things**
Searches, browsing, anything interesting or unusual.

Remember: INCLUDE ACTUAL QUOTES from the messages. This is essential.

Events (${eventCount} total):

${renderedEvents}`;
}

/**
 * Build prompt for summarizing a single source's events (used in chunked summarization)
 */
function buildSourceSummaryPrompt(source: string, renderedEvents: string, eventCount: number): string {
  return `Summarize these ${source} events from a person's timeline. Be very brief (1-3 sentences). Focus on key activities, patterns, or notable items.

Events (${eventCount} total):

${renderedEvents}`;
}

/**
 * Build prompt for combining source summaries into a final day summary
 */
function buildCombinedSummaryPrompt(date: string, sourceSummaries: string): string {
  return `Create a cohesive narrative summary of someone's day (${date}) based on these summaries from different data sources. Be conversational, as if telling someone about your day. Aim for 2-4 paragraphs.

Source summaries:
${sourceSummaries}`;
}

/** Delimiter between streamed summary text and trailing JSON metadata */
export const STREAM_METADATA_DELIMITER = "\0";

/** Keepalive byte sent to prevent idle timeout — stripped by the frontend */
export const STREAM_KEEPALIVE = "\x01";

/**
 * Stream a day summary. Returns a ReadableStream that emits:
 *   1. Summary text chunks (streamed as they arrive from the model)
 *   2. A null byte delimiter (\0)
 *   3. A JSON object with metadata (DaySummaryResult without `summary`)
 *
 * For cached/no-event responses, everything is emitted immediately.
 * For generated responses, text streams progressively from the model.
 */
export function streamDaySummary(
  timelineDb: QueryExecutor,
  appStateDb: Database,
  options: DaySummaryOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { date, forceRegenerate = false } = options;
  const model = options.model ?? getDefaultModel();

  // Use TransformStream so the readable side is returned to Bun immediately,
  // and writes happen from a detached async function. This ensures keepalive
  // spaces can flush to the client while we await the AI model.
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  const write = (text: string) => writer.write(encoder.encode(text));
  const writeResult = async (result: Omit<DaySummaryResult, "summary">) => {
    await write(STREAM_METADATA_DELIMITER);
    await write(JSON.stringify(result));
    await writer.close();
  };

  // Fire-and-forget: generate and stream
  (async () => {
    try {
      // Check cache first
      if (!forceRegenerate) {
        const cached = getCachedDaySummary(appStateDb, date, model);
        if (cached) {
          await write(cached.summary);
          await writeResult({
            date: cached.date,
            tokenCount: cached.token_count,
            eventCount: cached.event_count,
            model: cached.model,
            cached: true,
            metadata: cached.metadata ? JSON.parse(cached.metadata) : null,
          });
          return;
        }
      }

      // Fetch events for the day
      const events = (await getEvents(timelineDb, { date, limit: 10000 }))
        .filter(e => !SUMMARY_EXCLUDED_SOURCES.has(e.source));

      if (events.length === 0) {
        await write("No events found for this day.");
        await writeResult({
          date,
          tokenCount: 0,
          eventCount: 0,
          model,
          cached: false,
          metadata: null,
        });
        return;
      }

      // Render events and count tokens
      const replyQuotes = await loadReplyQuotesForEvents(timelineDb, events);
      const rendered = renderEvents(events, {
        compactAuthors: true,
        noSummaries: false,
        fullTimestamps: false,
        replyQuotes,
        splitConversations: true,
      });
      const estimatedTokenCount = countTokens(rendered);

      const languageModel = resolveLanguageModel(model);

      const tokenThreshold = getTokenThreshold(model);
      const startTime = Date.now();
      let summary = "";
      let metadata: SummaryMetadata;

      // Send keepalive bytes to prevent Bun's idle timeout (10s default)
      let keepalive: ReturnType<typeof setInterval> | null = setInterval(() => {
        write(STREAM_KEEPALIVE).catch(() => {});
      }, 5000);
      const stopKeepalive = () => { if (keepalive) { clearInterval(keepalive); keepalive = null; } };

      try {
        if (estimatedTokenCount <= tokenThreshold) {
          // Direct: stream from model
          const prompt = buildDaySummaryPrompt(date, rendered, events.length);
          const result = streamText({
            model: languageModel,
            prompt,
          });

          for await (const chunk of result.textStream) {
            await write(chunk);
            summary += chunk;
          }

          const finalStep = await result.finalStep;
          metadata = {
            ...extractUsage(finalStep.usage, finalStep.providerMetadata, finalStep.finishReason),
            generationMs: Date.now() - startTime,
          };
        } else {
          const chunked = await chunkedSummarizeStreaming(
            events, date, languageModel, tokenThreshold, write, replyQuotes,
          );
          summary = chunked.summary;
          metadata = chunked.metadata;
          metadata.generationMs = Date.now() - startTime;
        }
      } finally {
        stopKeepalive();
      }

      // Use actual input tokens from API when available, fall back to local estimate
      const tokenCount = metadata.inputTokens > 0 ? metadata.inputTokens : estimatedTokenCount;

      // Cache the result
      saveDaySummary(appStateDb, {
        date,
        model,
        summary,
        token_count: tokenCount,
        event_count: events.length,
        metadata: JSON.stringify(metadata),
      });

      await writeResult({
        date,
        tokenCount,
        eventCount: events.length,
        model,
        cached: false,
        metadata,
      });
    } catch (error) {
      // Send error as metadata JSON so frontend can display it
      await write(STREAM_METADATA_DELIMITER).catch(() => {});
      await write(JSON.stringify({
        error: "Failed to generate summary",
        details: error instanceof Error ? error.message : String(error),
      })).catch(() => {});
      await writer.close().catch(() => {});
    }
  })();

  return readable;
}

/**
 * Chunked summarization with streaming for the final combining call.
 * Sends keepalive spaces during per-source phase to prevent idle timeout.
 */
async function chunkedSummarizeStreaming(
  events: TimelineEvent[],
  date: string,
  languageModel: LanguageModel,
  tokenThreshold: number,
  write: (text: string) => Promise<void>,
  replyQuotes: ReplyQuotesByEvent,
): Promise<{ summary: string; metadata: SummaryMetadata }> {
  // Group events by source
  const groups = groupEvents(events);
  const sourceGroups = new Map<string, TimelineEvent[]>();
  for (const group of groups) {
    let arr = sourceGroups.get(group.source);
    if (!arr) {
      arr = [];
      sourceGroups.set(group.source, arr);
    }
    arr.push(...group.events);
  }

  const summaryPromises: Promise<{ source: string; summary: string; usage: SummaryMetadata }>[] = [];
  const maxTokensPerSource = Math.floor(tokenThreshold * 0.4);

  for (const [source, sourceEvents] of sourceGroups) {
    const rendered = renderEventGroup(sourceEvents, source, { replyQuotes });
    const tokens = countTokens(rendered);

    let truncatedRendered = rendered;
    if (tokens > maxTokensPerSource) {
      const lines = rendered.split("\n");
      let currentTokens = 0;
      const keptLines: string[] = [];
      for (const line of lines) {
        const lineTokens = countTokens(line);
        if (currentTokens + lineTokens > maxTokensPerSource) {
          keptLines.push(`... (${sourceEvents.length - keptLines.length} more events truncated)`);
          break;
        }
        keptLines.push(line);
        currentTokens += lineTokens;
      }
      truncatedRendered = keptLines.join("\n");
    }

    summaryPromises.push(
      (async () => {
        const prompt = buildSourceSummaryPrompt(source, truncatedRendered, sourceEvents.length);
        const result = await generateText({
          model: languageModel,
          prompt,
        });
        return {
          source,
          summary: result.text,
          usage: extractUsage(
            result.finalStep.usage,
            result.finalStep.providerMetadata,
            result.finalStep.finishReason,
          ),
        };
      })()
    );
  }

  const sourceSummaries = await Promise.all(summaryPromises);

  let totalUsage = sourceSummaries.reduce(
    (acc, { usage }) => mergeUsage(acc, usage),
    { inputTokens: 0, outputTokens: 0, generationMs: 0 } as SummaryMetadata
  );

  // Stream the final combining call
  const combinedInput = sourceSummaries
    .map(({ source, summary }) => `**${source}**: ${summary}`)
    .join("\n\n");

  const finalResult = streamText({
    model: languageModel,
    prompt: buildCombinedSummaryPrompt(date, combinedInput),
  });

  let summary = "";
  for await (const chunk of finalResult.textStream) {
    await write(chunk);
    summary += chunk;
  }

  const finalStep = await finalResult.finalStep;
  const finalUsage = extractUsage(
    finalStep.usage,
    finalStep.providerMetadata,
    finalStep.finishReason,
  );
  totalUsage = mergeUsage(totalUsage, finalUsage);

  return { summary, metadata: totalUsage };
}
