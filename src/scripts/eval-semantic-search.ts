/**
 * Score the labelled retrieval-eval corpus against the current semantic index.
 *
 * Usage: bun run src/scripts/eval-semantic-search.ts [--json] [--mode=events|windows|both] [--k=N]
 *
 * --mode picks the hits scored: single events (the default), conversation
 * windows, or both merged by distance. --k (default 10) is how deep
 * conversation coverage looks, for cases that list the conversations a query
 * should find.
 */

import { existsSync } from "node:fs";
import { getAppStateDbPath, getTimelineDbPath } from "../db/paths";
import { openReadonlyDbAtPath, openReadonlyTimelineDb } from "../db/readonly";
import { getEvalCase, listEvalCases, type EvalCaseDetail } from "../db/eval";
import { hydrateEventsById } from "../db/events";
import { wrapDatabase } from "../db/pool";
import {
  getEmbeddingsDb,
  getEmbeddingsDbPath,
  getModelProfile,
  openVectorSearchDb,
  type ContentProfile,
  type ModelProfile,
} from "../embeddings/db";
import { type EmbeddingsConfig, loadConfig } from "../config";
import { notConfiguredMessage, resolveEmbeddingProfile } from "../embeddings/config";
import { configureBunSqliteForSqliteVec } from "../embeddings/sqlite-vec";
import {
  DEFAULT_SEARCH_EXCLUDED_SOURCES,
  getSemanticSearchCandidateIds,
  postProcessSemanticSearch,
  type SemanticSearch,
  searchEmbeddingsWithWindows,
} from "../embeddings/search";
import {
  aggregateEvalQueryScores,
  type ConversationCoverage,
  type EvalQueryScore,
  type EvalSearchHit,
  scoreConversationCoverage,
  scoreEvalQuery,
} from "../eval/scoring";

type EvalMode = "events" | "windows" | "both";

interface ScoredHit extends EvalSearchHit {
  kind: "event" | "window";
  distance: number;
}

interface IndexedContentProfile extends Pick<ContentProfile, "name" | "version"> {}

interface QueryResult extends EvalQueryScore {
  id: number;
  text: string;
  hits: Array<{ kind: ScoredHit["kind"]; event_id: number; distance: number }>;
  conversation_coverage: ConversationCoverage | null;
}

interface CaseResult {
  id: number;
  name: string;
  category: string;
  queries: QueryResult[];
  scored_query_count: number;
  skipped_query_count: number;
  recall_at_10: number | null;
  mrr: number | null;
  negatives_retrieved: number;
  conversations_at_k: number | null;
}

interface EvalRunResult {
  mode: EvalMode;
  k: number;
  model_profile: Pick<ModelProfile, "name" | "model" | "dimensions">;
  content_profiles: IndexedContentProfile[];
  cases: CaseResult[];
  overall: {
    query_count: number;
    skipped_query_count: number;
    total_query_count: number;
    recall_at_10: number | null;
    mrr: number | null;
    negatives_retrieved: number;
    conversations_at_k: number | null;
  };
}

/** Mean share of expected conversations found, over the queries whose case lists any. */
function meanCoverage(queries: QueryResult[]): number | null {
  const covered = queries.flatMap((query) => (query.conversation_coverage ? [query.conversation_coverage] : []));
  if (covered.length === 0) return null;
  return covered.reduce((total, coverage) => total + coverage.found / coverage.expected, 0) / covered.length;
}

function requireDatabase(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
}

function formatMetric(value: number | null): string {
  return value === null ? "skipped" : value.toFixed(3);
}

function loadEvalCases(appStatePath: string): EvalCaseDetail[] {
  const appStateDb = openReadonlyDbAtPath(appStatePath);
  try {
    const summaries = listEvalCases(appStateDb);
    if (summaries.length === 0) {
      throw new Error(`Eval tables are empty in ${appStatePath}: no eval cases found`);
    }
    const cases = summaries.map((summary) => {
      const detail = getEvalCase(appStateDb, summary.id);
      if (!detail) throw new Error(`Eval case ${summary.id} disappeared while loading`);
      return detail;
    });
    const queryCount = cases.reduce((count, evalCase) => count + evalCase.queries.length, 0);
    const expectationCount = cases.reduce((count, evalCase) => count + evalCase.expectations.length, 0);
    if (queryCount === 0 || expectationCount === 0) {
      throw new Error(
        `Eval tables are empty in ${appStatePath}: found ${queryCount} queries and ${expectationCount} expectations`,
      );
    }
    return cases;
  } finally {
    appStateDb.close();
  }
}

function loadIndexProfiles(embeddingsConfig: EmbeddingsConfig | undefined, embeddingsPath: string): {
  modelProfile: Pick<ModelProfile, "name" | "model" | "dimensions">;
  contentProfiles: IndexedContentProfile[];
} {
  const config = resolveEmbeddingProfile(embeddingsConfig);
  const embeddingsDb = getEmbeddingsDb(embeddingsPath, { readonly: true });
  try {
    const modelProfile = getModelProfile(embeddingsDb, config.name);
    if (!modelProfile) {
      throw new Error(`Embedding model profile "${config.name}" is not indexed in ${embeddingsPath}`);
    }
    if (
      modelProfile.model !== config.model ||
      modelProfile.dimensions !== config.dimensions ||
      modelProfile.document_prefix !== config.document_prefix
    ) {
      throw new Error(
        `Embedding model profile "${config.name}" does not match the configured model, dimensions, or document prefix`,
      );
    }
    const contentProfiles = embeddingsDb
      .prepare(
        `SELECT DISTINCT cp.name, cp.version
         FROM content_profiles cp
         JOIN embedding_documents ed ON ed.content_profile_id = cp.id
         JOIN embedding_vectors ev ON ev.document_id = ed.id
         WHERE ev.model_profile_id = ?
         ORDER BY cp.name, cp.version`,
      )
      .all(modelProfile.id) as IndexedContentProfile[];
    if (contentProfiles.length === 0) {
      throw new Error(`Embedding model profile "${config.name}" has no indexed content in ${embeddingsPath}`);
    }
    return {
      modelProfile: {
        name: modelProfile.name,
        model: modelProfile.model,
        dimensions: modelProfile.dimensions,
      },
      contentProfiles,
    };
  } finally {
    embeddingsDb.close();
  }
}

async function run(mode: EvalMode, k: number): Promise<EvalRunResult> {
  // Both must precede every bun:sqlite open in this process: setCustomSQLite
  // throws once SQLite has auto-loaded, the eval tables are read before the
  // sqlite-vec-backed embeddings DB, and TIMELINE_SQLITE_LIBRARY_PATH usually
  // arrives from ~/.config/timeline/env rather than the caller's shell.
  const embeddingsConfig = (await loadConfig()).embeddings;
  configureBunSqliteForSqliteVec();
  const timelinePath = getTimelineDbPath();
  const appStatePath = getAppStateDbPath(timelinePath);
  const embeddingsPath = getEmbeddingsDbPath(timelinePath);
  requireDatabase(timelinePath, "Timeline database");
  requireDatabase(appStatePath, "App-state database");
  const evalCases = loadEvalCases(appStatePath);
  requireDatabase(embeddingsPath, "Embeddings database");
  const { modelProfile, contentProfiles } = loadIndexProfiles(embeddingsConfig, embeddingsPath);
  if (!embeddingsConfig) throw new Error(notConfiguredMessage());
  if (mode !== "events" && !contentProfiles.some((profile) => profile.name.startsWith("conversation-window:"))) {
    throw new Error(`--mode=${mode} needs conversation windows, and ${embeddingsPath} has none for this model`);
  }
  const depth = Math.max(10, k);
  const vectorDb = openVectorSearchDb(embeddingsPath);
  const search: SemanticSearch = { config: embeddingsConfig, embeddingsDb: async () => wrapDatabase(vectorDb) };
  const timelineDb = openReadonlyTimelineDb();
  const readDb = wrapDatabase(timelineDb);
  const excludedSources = new Set<string>(DEFAULT_SEARCH_EXCLUDED_SOURCES);

  try {
    const cases: CaseResult[] = [];
    for (const evalCase of evalCases) {
      const queries: QueryResult[] = [];
      for (const query of evalCase.queries) {
        // Fetch past depth, since excluded sources are dropped after the nearest-neighbour search.
        const candidates = Math.max(100, depth * 2);
        const { hits, windows } = await searchEmbeddingsWithWindows(search, query.text, candidates, candidates);
        const { events } = await hydrateEventsById(readDb, getSemanticSearchCandidateIds(hits));
        const eventHits: ScoredHit[] = postProcessSemanticSearch(hits, events, excludedSources, depth).map((hit) => ({
          kind: "event",
          distance: hit.distance,
          event_id: hit.id,
          source: hit.source,
          conversation_id: hit.conversation_id,
          timestamp: hit.timestamp,
        }));
        const windowHits: ScoredHit[] = windows
          .filter((hit) => !excludedSources.has(hit.source))
          .flatMap((hit) => {
            const first = hit.eventIds[0];
            if (first === undefined) return [];
            return [{
              kind: "window" as const,
              distance: hit.distance,
              event_id: first,
              event_ids: hit.eventIds,
              source: hit.source,
              conversation_id: hit.conversationId,
              timestamp: hit.start,
              end_timestamp: hit.end,
            }];
          });
        // Both kinds share the model's vector space, so "both" merges them by distance.
        const scored = (mode === "events" ? eventHits : mode === "windows" ? windowHits : [...eventHits, ...windowHits])
          .sort((left, right) => left.distance - right.distance)
          .slice(0, depth);
        const score = scoreEvalQuery(evalCase.expectations, scored.slice(0, 10));
        queries.push({
          id: query.id,
          text: query.text,
          hits: scored.slice(0, 10).map((hit) => ({ kind: hit.kind, event_id: hit.event_id, distance: hit.distance })),
          conversation_coverage: scoreConversationCoverage(evalCase.expectations, scored, k),
          ...score,
        });
      }
      const aggregate = aggregateEvalQueryScores(queries);
      cases.push({
        id: evalCase.id,
        name: evalCase.name,
        category: evalCase.category,
        queries,
        scored_query_count: aggregate.query_count,
        skipped_query_count: aggregate.skipped_query_count,
        recall_at_10: aggregate.recall_at_10,
        mrr: aggregate.mrr,
        negatives_retrieved: queries.reduce((count, query) => count + query.negatives_retrieved, 0),
        conversations_at_k: meanCoverage(queries),
      });
    }
    const queries = cases.flatMap((evalCase) => evalCase.queries);
    const aggregate = aggregateEvalQueryScores(queries);
    return {
      mode,
      k,
      model_profile: modelProfile,
      content_profiles: contentProfiles,
      cases,
      overall: {
        query_count: aggregate.query_count,
        skipped_query_count: aggregate.skipped_query_count,
        total_query_count: queries.length,
        recall_at_10: aggregate.recall_at_10,
        mrr: aggregate.mrr,
        negatives_retrieved: queries.reduce((count, query) => count + query.negatives_retrieved, 0),
        conversations_at_k: meanCoverage(queries),
      },
    };
  } finally {
    timelineDb.close();
    vectorDb.close();
  }
}

function printHuman(result: EvalRunResult): void {
  const contentProfiles = result.content_profiles.map((profile) => `${profile.name}:v${profile.version}`).join(", ");
  console.log(`Embedding model: ${result.model_profile.name} (${result.model_profile.model}, ${result.model_profile.dimensions}d)`);
  console.log(`Content profile: ${contentProfiles}`);
  console.log(`Hits scored: ${result.mode}`);
  console.log(`\nCase | Query | Recall@10 | MRR rank | Negatives | Conversations@${result.k}`);
  console.log("--- | --- | ---: | ---: | ---: | ---:");
  for (const evalCase of result.cases) {
    for (const query of evalCase.queries) {
      const coverage = query.conversation_coverage;
      console.log(
        `${evalCase.name} | ${query.text} | ${formatMetric(query.recall_at_10)}${query.skip_reason ? ` (${query.skip_reason})` : ""} | ${query.first_grade_2_rank ?? "-"} | ${query.negatives_retrieved} | ${coverage ? `${coverage.found}/${coverage.expected}` : "-"}`,
      );
    }
    console.log(
      `${evalCase.name} (average) | ${evalCase.scored_query_count} scored, ${evalCase.skipped_query_count} skipped | ${formatMetric(evalCase.recall_at_10)} | ${formatMetric(evalCase.mrr)} | ${evalCase.negatives_retrieved} | ${formatMetric(evalCase.conversations_at_k)}`,
    );
  }
  console.log(
    `\nOverall (${result.overall.query_count} scored queries, ${result.overall.skipped_query_count} skipped unlabelled of ${result.overall.total_query_count} total): recall@10 ${formatMetric(result.overall.recall_at_10)}, MRR ${formatMetric(result.overall.mrr)}, negatives ${result.overall.negatives_retrieved}, conversations@${result.k} ${formatMetric(result.overall.conversations_at_k)}`,
  );
}

const USAGE = "Usage: bun run src/scripts/eval-semantic-search.ts [--json] [--mode=events|windows|both] [--k=N]";
const args = process.argv.slice(2);
let mode: EvalMode = "events";
let k = 10;
for (const arg of args) {
  if (arg === "--json") continue;
  const [flag, value] = arg.split("=", 2);
  if (flag === "--mode" && (value === "events" || value === "windows" || value === "both")) mode = value;
  else if (flag === "--k" && value && Number.isInteger(Number(value)) && Number(value) > 0) k = Number(value);
  else throw new Error(USAGE);
}

const result = await run(mode, k);
if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
else printHuman(result);
