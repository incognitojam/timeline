import { Effect } from "effect";
import type { EmbeddingsConfig } from "../config";
import type { QueryExecutor } from "../db/pool";
import { NOISY_MACHINE_SOURCES } from "../shared/noisy-sources";
import { createEmbeddingClient, resolveEmbeddingProfile } from "./config";
import { queryVectors, queryWindowVectors, readModelProfile, type SearchHit, type WindowSearchHit } from "./db";
import { parseConversationKey } from "./windows";

/**
 * Sources excluded from semantic search results by default: AI-agent session
 * transcripts and screen-recall OCR are verbose, topically dense, and mention
 * everything, so they crowd out the events a query is actually about. They stay
 * in the index — callers opt back in by passing their own exclusion list.
 */
export const DEFAULT_SEARCH_EXCLUDED_SOURCES = NOISY_MACHINE_SOURCES;

/** What semantic search needs: the embedding model and read access to its index. */
export interface SemanticSearch {
  config: EmbeddingsConfig;
  /**
   * Read-only embeddings.db, opened for vector search (see openVectorSearchDb).
   * Opened on first use, so a host without an index fails only when it searches.
   */
  embeddingsDb: () => Promise<QueryExecutor>;
}

/** Open embeddings.db on first use and share it, opening again after a failure. */
export function openOnFirstUse(open: () => Promise<QueryExecutor>): () => Promise<QueryExecutor> {
  let opening: Promise<QueryExecutor> | undefined;
  return () => {
    opening ??= open().catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };
}

async function embedSearchQuery(search: SemanticSearch, query: string) {
  const modelConfig = resolveEmbeddingProfile(search.config);
  const db = await search.embeddingsDb();
  const modelProfile = await readModelProfile(db, modelConfig.name);
  if (!modelProfile) {
    throw new Error(`Embedding model profile "${modelConfig.name}" is not indexed in embeddings.db`);
  }
  if (
    modelProfile.model !== modelConfig.model ||
    modelProfile.dimensions !== modelConfig.dimensions ||
    modelProfile.document_prefix !== modelConfig.document_prefix
  ) {
    throw new Error(
      `Embedding model profile "${modelConfig.name}" does not match the configured model, dimensions, or document prefix`,
    );
  }
  const client = createEmbeddingClient(modelConfig);
  const vector = await Effect.runPromise(client.embedQuery(query));
  return { db, modelProfile, vector };
}

/**
 * Embed a free-text query with the configured model and return the nearest
 * indexed events from embeddings.db, closest first. A document may map to more
 * than one event, so the result can contain more than `limit` rows; callers that
 * want at most `limit` events should dedupe and cap.
 */
export async function searchEmbeddings(search: SemanticSearch, query: string, limit: number): Promise<SearchHit[]> {
  const { db, modelProfile, vector } = await embedSearchQuery(search, query);
  return queryVectors(db, vector, modelProfile, limit);
}

/** A conversation window near the query: one stretch of one conversation. */
export interface WindowHit {
  distance: number;
  source: string;
  sourceAccount: string | null;
  conversationId: string;
  title: string | null;
  start: string;
  end: string;
  /** The window's own messages, in order; the first is the example `#id` shown for it. */
  eventIds: number[];
  snippet: string | null;
}

/**
 * searchEmbeddings, plus the nearest conversation windows ranked on their
 * own, from one embedding of the query. There are no window hits until a
 * window pilot has indexed some.
 */
export async function searchEmbeddingsWithWindows(
  search: SemanticSearch,
  query: string,
  limit: number,
  windowLimit: number,
): Promise<{ hits: SearchHit[]; windows: WindowHit[]; windowsError?: string }> {
  const { db, modelProfile, vector } = await embedSearchQuery(search, query);
  const hits = await queryVectors(db, vector, modelProfile, limit);
  // The pilot's windows must not take the event results down with them.
  try {
    return { hits, windows: (await queryWindowVectors(db, vector, modelProfile, windowLimit)).map(toWindowHit) };
  } catch (error) {
    return { hits, windows: [], windowsError: error instanceof Error ? error.message : String(error) };
  }
}

export function toWindowHit(hit: WindowSearchHit): WindowHit {
  const conversation = parseConversationKey(hit.conversation_key);
  const eventIds: unknown = JSON.parse(hit.primary_event_ids);
  if (!Array.isArray(eventIds) || !eventIds.every((id) => typeof id === "number")) {
    throw new Error(`Window document ${hit.document_id} has invalid event ids`);
  }
  return {
    distance: hit.distance,
    source: conversation.source,
    sourceAccount: conversation.sourceAccount,
    conversationId: conversation.conversationId,
    title: hit.title,
    start: hit.start_timestamp,
    end: hit.end_timestamp,
    eventIds,
    snippet: hit.snippet,
  };
}

/** One line per window hit: `window discord "Rowan" 2023-12-11 03:07–03:13 #5 conversation 1039…: excerpt` */
export function formatWindowHit(hit: WindowHit): string {
  const start = hit.start.slice(0, 16).replace("T", " ");
  const end = hit.end.slice(0, 10) === hit.start.slice(0, 10) ? hit.end.slice(11, 16) : hit.end.slice(0, 16).replace("T", " ");
  const excerpt = (hit.snippet ?? "").replace(/\s+/g, " ").slice(0, 120);
  return `window ${hit.source} "${hit.title ?? "(untitled)"}" ${start}–${end} #${hit.eventIds[0]} conversation ${hit.conversationId}: ${excerpt}`;
}

export interface SemanticSearchCandidate {
  id: number;
  source: string;
}

export type SemanticSearchResult<T extends SemanticSearchCandidate> = T & { distance: number };

function nearestDistancesByEventId(hits: Iterable<SearchHit>): Map<number, number> {
  const nearestByEventId = new Map<number, { distance: number; firstIndex: number }>();
  let index = 0;
  for (const hit of hits) {
    const existing = nearestByEventId.get(hit.event_id);
    if (!existing || hit.distance < existing.distance) {
      nearestByEventId.set(hit.event_id, { distance: hit.distance, firstIndex: index });
    }
    index++;
  }

  return new Map(
    [...nearestByEventId.entries()]
      .sort(([, left], [, right]) => left.distance - right.distance || left.firstIndex - right.firstIndex)
      .map(([eventId, entry]) => [eventId, entry.distance]),
  );
}

/** Event IDs in semantic rank order after document-to-event deduplication. */
export function getSemanticSearchCandidateIds(hits: Iterable<SearchHit>): number[] {
  return [...nearestDistancesByEventId(hits).keys()];
}

/**
 * Apply the result contract shared by semantic-search callers after event
 * hydration: nearest document distance wins per event, excluded sources are
 * removed, then the visible result count is capped.
 */
export function postProcessSemanticSearch<T extends SemanticSearchCandidate>(
  hits: Iterable<SearchHit>,
  candidates: Iterable<T>,
  excludedSources: ReadonlySet<string>,
  limit: number,
): SemanticSearchResult<T>[] {
  const distanceByEventId = nearestDistancesByEventId(hits);

  return [...candidates]
    .filter((event) => !excludedSources.has(event.source) && distanceByEventId.has(event.id))
    .slice(0, limit)
    .map((event) => {
      const distance = distanceByEventId.get(event.id);
      if (distance === undefined) throw new Error(`Missing semantic distance for event ${event.id}`);
      return { ...event, distance };
    });
}
