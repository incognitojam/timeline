import type { Database } from "bun:sqlite";
import { streamText } from "ai";
import { getEvents } from "../db/queries";
import type { QueryExecutor } from "../db/pool";
import type { TimelineEvent } from "../db/schema";
import { renderEventGroupWithSummary, groupEvents } from "../export/render";
import { loadReplyQuotesForEvents, type ReplyQuotesByEvent } from "../export/reply-quotes";
import type { EventGroupData } from "../shared/grouping";
import { countTokens } from "../export/tokens";
import {
  getCachedJournalSession,
  saveJournalSession,
  type JournalQuestion,
} from "../db/app-state";
import { getContextLength, getDefaultModel, resolveLanguageModel } from "../llm";
import {
  STREAM_METADATA_DELIMITER,
  STREAM_KEEPALIVE,
  SUMMARY_EXCLUDED_SOURCES,
} from "../summary/day-summary";

export interface JournalQuestionsOptions {
  date: string;
  model?: string;
  regenerate?: boolean;
}

export interface JournalQuestionsResult {
  questions: JournalQuestion[];
  model: string;
  cached: boolean;
  eventCount: number;
  rawResponse?: string;
}

function buildQuestionPrompt(date: string, renderedEvents: string, eventCount: number): string {
  return `You are helping someone journal about their day (${date}). Based on their activity data below, generate exactly 6 thoughtful questions to prompt personal reflection.

CRITICAL - understanding the data:
- This is a personal timeline that includes the user's OWN activities AND messages from OTHER people in conversations they participate in.
- Messages show "PersonName: message text" — most of these are from OTHER people, not the user. Do NOT assume the user did something just because someone mentioned it in a conversation.
- Only attribute activities to the user if they come from non-message sources (Spotify listens, Google searches, location visits, code sessions, transactions, etc.) — these are definitively the user's own actions.
- For conversations, ask about the DISCUSSION or what the user THOUGHT about it, not about the activities other people mentioned. For example, if Alice says "looking at flats near the station", ask "Alice mentioned flat-hunting — how's that going for her?" NOT "How did your flat viewings go?"
- Discord server messages (group chats with many people) are things the user READ, not necessarily participated in.

Guidelines:
- Reference SPECIFIC events from their day (names, places, songs, topics)
- Mix question types: 2-3 activity-based, 1-2 social, 1 media/interests, 1 open-ended/emotional
- Keep questions conversational and warm, not clinical
- Questions should be answerable in 1-3 sentences
- Avoid yes/no questions — ask "what" and "how" instead
- For conversations, ask what the user thought about a topic discussed, or how a person is doing
- For the user's OWN activities (music, searches, locations, coding, purchases), ask about those directly
- Always include one gratitude or mood question
- If it's a quiet day with few events, ask more open-ended/reflective questions

Each event group has an ID in its header like [group:abc123]. For each question, include the group IDs that inspired it.

Respond ONLY with a JSON array of objects, each with "question" (string), "category" (one of: "activity", "social", "media", "work", "open", "gratitude", "mood"), and "group_ids" (array of strings — the group IDs that this question references). No markdown, no explanation, no code fences.

Activity data for ${date} (${eventCount} events):

${renderedEvents}`;
}

function buildReflectionPrompt(
  date: string,
  renderedEvents: string,
  eventCount: number,
  qaPairs: Array<{ question: string; answer: string }>,
): string {
  const qaText = qaPairs
    .map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`)
    .join("\n\n");

  return `Write a reflective summary of someone's day (${date}), written in third person. You have two inputs:

1. Their activity data (${eventCount} events — what they did, who they talked to, what they consumed)
2. Their own answers to reflection questions

IMPORTANT: The activity data includes messages from OTHER people in conversations. Only Spotify listens, searches, location visits, transactions, code sessions etc. are definitively the user's own actions. Messages labeled "PersonName: text" are mostly from other people. Don't attribute other people's activities to the user.

Weave these together into a concise third-person narrative (2-3 paragraphs). Include:
- Key moments and activities from the day (only things they actually did)
- Their own thoughts and feelings (from the Q&A), attributed naturally
- Any patterns or connections you notice

Write as an observer summarising their day. Be direct and genuine, not saccharine.

Activity data:
${renderedEvents}

Their reflections:
${qaText}`;
}

/**
 * Render grouped events with group IDs in headers for citation.
 * e.g. "[group:discord_general] === discord: General Chat (45 messages) ==="
 */
function renderGroupedEventsWithIds(
  groups: EventGroupData<TimelineEvent>[],
  replyQuotes: ReplyQuotesByEvent,
): string {
  const sections: string[] = [];
  for (const group of groups) {
    const rendered = renderEventGroupWithSummary(group, {
      compactAuthors: true,
      noSummaries: false,
      fullTimestamps: false,
      replyQuotes,
    });
    // Inject group ID into the header line
    const lines = rendered.split("\n");
    if (lines.length > 0) {
      lines[0] = `[group:${group.id}] ${lines[0]}`;
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

interface DayEventsData {
  rendered: string;
  eventCount: number;
  groups: EventGroupData<TimelineEvent>[];
}

/**
 * Fetch and render day events for journal prompts.
 * Groups events and tags each group with an ID for citation.
 */
async function fetchDayEventsRendered(
  timelineDb: QueryExecutor,
  date: string,
  model: string,
): Promise<DayEventsData | null> {
  const events = (await getEvents(timelineDb, { date, limit: 10000 })).filter(
    (e) => !SUMMARY_EXCLUDED_SOURCES.has(e.source),
  );
  if (events.length === 0) return null;

  const groups = groupEvents(events);
  const replyQuotes = await loadReplyQuotesForEvents(timelineDb, events);
  const rendered = renderGroupedEventsWithIds(groups, replyQuotes);
  const tokenCount = countTokens(rendered);
  const contextLength = getContextLength(model);
  const maxTokens = Math.floor(10 * Math.pow(contextLength, 0.75));

  // Truncate if needed
  if (tokenCount > maxTokens) {
    const lines = rendered.split("\n");
    let currentTokens = 0;
    const keptLines: string[] = [];
    for (const line of lines) {
      const lineTokens = countTokens(line);
      if (currentTokens + lineTokens > maxTokens) {
        keptLines.push(`... (truncated, ${events.length} total events)`);
        break;
      }
      keptLines.push(line);
      currentTokens += lineTokens;
    }
    return { rendered: keptLines.join("\n"), eventCount: events.length, groups };
  }

  return { rendered, eventCount: events.length, groups };
}

/**
 * Stream journal questions for a day.
 * Returns a ReadableStream using the same protocol as day summaries:
 *   1. JSON text (the questions array)
 *   2. Null byte delimiter
 *   3. JSON metadata
 */
export function streamJournalQuestions(
  timelineDb: QueryExecutor,
  appStateDb: Database,
  options: JournalQuestionsOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { date, regenerate = false } = options;
  const model = options.model ?? getDefaultModel();

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  const write = (text: string) => writer.write(encoder.encode(text));
  const writeResult = async (result: JournalQuestionsResult) => {
    await write(STREAM_METADATA_DELIMITER);
    await write(JSON.stringify(result));
    await writer.close();
  };

  (async () => {
    try {
      // Check cache first
      if (!regenerate) {
        const cached = getCachedJournalSession(appStateDb, date, model);
        if (cached) {
          await write(JSON.stringify(cached.questions));
          await writeResult({
            questions: cached.questions,
            model,
            cached: true,
            eventCount: 0,
          });
          return;
        }
      }

      // Fetch events
      const dayData = await fetchDayEventsRendered(timelineDb, date, model);
      if (!dayData) {
        const fallbackQuestions: JournalQuestion[] = [
          { question: "How are you feeling right now?", category: "mood" },
          { question: "What's been on your mind today?", category: "open" },
          { question: "What are you grateful for today?", category: "gratitude" },
        ];
        await write(JSON.stringify(fallbackQuestions));
        await writeResult({
          questions: fallbackQuestions,
          model,
          cached: false,
          eventCount: 0,
        });
        return;
      }

      const prompt = buildQuestionPrompt(date, dayData.rendered, dayData.eventCount);

      const languageModel = resolveLanguageModel(model);

      let keepalive: ReturnType<typeof setInterval> | null = setInterval(() => {
        write(STREAM_KEEPALIVE).catch(() => {});
      }, 5000);
      const stopKeepalive = () => {
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = null;
        }
      };

      try {
        const result = streamText({
          model: languageModel,
          prompt,
        });

        let fullText = "";
        for await (const chunk of result.textStream) {
          await write(chunk);
          fullText += chunk;
        }

        stopKeepalive();

        // Parse questions from model output, validating group IDs
        const validGroupIds = new Set(dayData.groups.map((g) => g.id));
        const questions = parseQuestions(fullText, validGroupIds);

        if (questions.length === 0) {
          // Model returned non-JSON or refused — surface as error, don't cache
          throw new Error(fullText.slice(0, 500) || "Model returned no questions");
        }

        // Cache the session
        saveJournalSession(appStateDb, date, model, questions);

        await writeResult({
          questions,
          model,
          cached: false,
          eventCount: dayData.eventCount,
          rawResponse: fullText,
        });
      } finally {
        stopKeepalive();
      }
    } catch (error) {
      await write(STREAM_METADATA_DELIMITER).catch(() => {});
      await write(
        JSON.stringify({
          error: "Failed to generate questions",
          details: error instanceof Error ? error.message : String(error),
        }),
      ).catch(() => {});
      await writer.close().catch(() => {});
    }
  })();

  return readable;
}

/**
 * Stream a journal reflection for a day.
 */
export function streamJournalReflection(
  timelineDb: QueryExecutor,
  options: {
    date: string;
    model?: string;
    qaPairs: Array<{ question: string; answer: string }>;
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { date, qaPairs } = options;
  const model = options.model ?? getDefaultModel();

  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();

  const write = (text: string) => writer.write(encoder.encode(text));

  (async () => {
    try {
      const dayData = await fetchDayEventsRendered(timelineDb, date, model);
      const rendered = dayData?.rendered ?? "(no activity data available)";
      const eventCount = dayData?.eventCount ?? 0;

      const prompt = buildReflectionPrompt(date, rendered, eventCount, qaPairs);

      const languageModel = resolveLanguageModel(model);

      let keepalive: ReturnType<typeof setInterval> | null = setInterval(() => {
        write(STREAM_KEEPALIVE).catch(() => {});
      }, 5000);
      const stopKeepalive = () => {
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = null;
        }
      };

      try {
        const result = streamText({
          model: languageModel,
          prompt,
        });

        let fullText = "";
        for await (const chunk of result.textStream) {
          await write(chunk);
          fullText += chunk;
        }

        stopKeepalive();

        await write(STREAM_METADATA_DELIMITER);
        await write(JSON.stringify({ reflection: fullText }));
        await writer.close();
      } finally {
        stopKeepalive();
      }
    } catch (error) {
      await write(STREAM_METADATA_DELIMITER).catch(() => {});
      await write(
        JSON.stringify({
          error: "Failed to generate reflection",
          details: error instanceof Error ? error.message : String(error),
        }),
      ).catch(() => {});
      await writer.close().catch(() => {});
    }
  })();

  return readable;
}

/**
 * Parse questions from model output. Handles JSON with or without code fences.
 * Validates group_ids against actual groups to filter hallucinated IDs.
 */
function parseQuestions(text: string, validGroupIds?: Set<string>): JournalQuestion[] {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (q: unknown): q is JournalQuestion =>
          typeof q === "object" &&
          q !== null &&
          typeof (q as JournalQuestion).question === "string" &&
          typeof (q as JournalQuestion).category === "string",
      )
      .map((q) => {
        let groupIds: string[] | undefined;
        if (Array.isArray(q.group_ids)) {
          groupIds = q.group_ids
            .filter((id): id is string => typeof id === "string")
            .filter((id) => !validGroupIds || validGroupIds.has(id));
          if (groupIds.length === 0) groupIds = undefined;
        }
        return {
          question: q.question,
          category: q.category,
          group_ids: groupIds,
        };
      });
  } catch {
    return [];
  }
}
