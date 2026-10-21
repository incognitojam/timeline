/**
 * Score the labelled retrieval-eval corpus against the current semantic index.
 *
 * Usage: bun run src/scripts/eval-semantic-search.ts [--json]
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
  searchEmbeddings,
} from "../embeddings/search";
import { aggregateEvalQueryScores, scoreEvalQuery, type EvalQueryScore } from "../eval/scoring";

interface IndexedContentProfile extends Pick<ContentProfile, "name" | "version"> {}

interface QueryResult extends EvalQueryScore {
  id: number;
  text: string;
  hits: Array<{ event_id: number; distance: number }>;
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
}

interface EvalRunResult {
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
  };
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

async function run(): Promise<EvalRunResult> {
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
        const hits = await searchEmbeddings(search, query.text, 100);
        const { events: candidates } = await hydrateEventsById(readDb, getSemanticSearchCandidateIds(hits));
        const visibleHits = postProcessSemanticSearch(hits, candidates, excludedSources, 10);
        const score = scoreEvalQuery(
          evalCase.expectations,
          visibleHits.map((hit) => ({
            event_id: hit.id,
            conversation_id: hit.conversation_id,
            timestamp: hit.timestamp,
          })),
        );
        queries.push({
          id: query.id,
          text: query.text,
          hits: visibleHits.map((hit) => ({ event_id: hit.id, distance: hit.distance })),
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
      });
    }
    const queries = cases.flatMap((evalCase) => evalCase.queries);
    const aggregate = aggregateEvalQueryScores(queries);
    return {
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
  console.log("\nCase | Query | Recall@10 | MRR rank | Negatives");
  console.log("--- | --- | ---: | ---: | ---:");
  for (const evalCase of result.cases) {
    for (const query of evalCase.queries) {
      console.log(
        `${evalCase.name} | ${query.text} | ${formatMetric(query.recall_at_10)}${query.skip_reason ? ` (${query.skip_reason})` : ""} | ${query.first_grade_2_rank ?? "-"} | ${query.negatives_retrieved}`,
      );
    }
    console.log(
      `${evalCase.name} (average) | ${evalCase.scored_query_count} scored, ${evalCase.skipped_query_count} skipped | ${formatMetric(evalCase.recall_at_10)} | ${formatMetric(evalCase.mrr)} | ${evalCase.negatives_retrieved}`,
    );
  }
  console.log(
    `\nOverall (${result.overall.query_count} scored queries, ${result.overall.skipped_query_count} skipped unlabelled of ${result.overall.total_query_count} total): recall@10 ${formatMetric(result.overall.recall_at_10)}, MRR ${formatMetric(result.overall.mrr)}, negatives ${result.overall.negatives_retrieved}`,
  );
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--json")) {
  throw new Error("Usage: bun run src/scripts/eval-semantic-search.ts [--json]");
}

const result = await run();
if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
else printHuman(result);
