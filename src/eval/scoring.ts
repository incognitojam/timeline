import type { EvalExpectation } from "../db/eval";

export interface EvalSearchHit {
  event_id: number;
  source?: string;
  conversation_id: string | null;
  timestamp: string | null;
  /** A conversation-window hit spans from timestamp to here. */
  end_timestamp?: string | null;
  /** A conversation-window hit's own messages, any of which matches an event expectation. */
  event_ids?: readonly number[];
}

export interface EvalQueryScore {
  scorable: boolean;
  skip_reason: "unlabelled" | null;
  recall_at_10: number | null;
  mrr: number | null;
  first_grade_2_rank: number | null;
  negatives_retrieved: number;
  none_score: number | null;
  positive_expectation_count: number;
  retrieved_positive_expectation_count: number;
}

export interface EvalScoreAggregate {
  query_count: number;
  skipped_query_count: number;
  recall_at_10: number | null;
  mrr: number | null;
}

function matchesRange(expectation: EvalExpectation, hit: EvalSearchHit): boolean {
  const conversationMatches =
    expectation.conversation_id !== null && hit.conversation_id === expectation.conversation_id;
  const timestampMatches =
    expectation.start_timestamp !== null &&
    expectation.end_timestamp !== null &&
    hit.timestamp !== null &&
    (hit.end_timestamp ?? hit.timestamp) >= expectation.start_timestamp &&
    hit.timestamp <= expectation.end_timestamp;
  return conversationMatches || timestampMatches;
}

export function matchesEvalExpectation(expectation: EvalExpectation, hit: EvalSearchHit): boolean {
  switch (expectation.kind) {
    case "event":
      return (
        expectation.event_id === hit.event_id ||
        (expectation.event_id !== null && (hit.event_ids?.includes(expectation.event_id) ?? false))
      );
    case "range":
      return matchesRange(expectation, hit);
    case "none":
      return false;
  }
}

/** Score one top-10 result list against all expectations for its eval case. */
export function scoreEvalQuery(expectations: EvalExpectation[], hits: EvalSearchHit[]): EvalQueryScore {
  const positiveExpectations = expectations.filter((expectation) => expectation.grade >= 1);
  const negativeExpectations = expectations.filter((expectation) => expectation.grade === 0);
  const retrievedPositiveCount = positiveExpectations.filter((expectation) =>
    hits.some((hit) => matchesEvalExpectation(expectation, hit)),
  ).length;
  const hasNoneExpectation = expectations.some((expectation) => expectation.kind === "none");
  const scorable = expectations.length > 0;
  const noneScore = hasNoneExpectation ? (retrievedPositiveCount === 0 ? 1 : 0) : null;
  const recallAt10 = !scorable
    ? null
    : positiveExpectations.length > 0
    ? retrievedPositiveCount / positiveExpectations.length
    : (noneScore ?? 0);
  const firstGrade2Index = hits.findIndex((hit) =>
    expectations.some((expectation) => expectation.grade === 2 && matchesEvalExpectation(expectation, hit)),
  );

  return {
    scorable,
    skip_reason: scorable ? null : "unlabelled",
    recall_at_10: recallAt10,
    mrr: scorable ? (firstGrade2Index === -1 ? 0 : 1 / (firstGrade2Index + 1)) : null,
    first_grade_2_rank: firstGrade2Index === -1 ? null : firstGrade2Index + 1,
    negatives_retrieved: negativeExpectations.filter((expectation) =>
      hits.some((hit) => matchesEvalExpectation(expectation, hit)),
    ).length,
    none_score: noneScore,
    positive_expectation_count: positiveExpectations.length,
    retrieved_positive_expectation_count: retrievedPositiveCount,
  };
}

/** Aggregate only queries that have expectations and can therefore be scored. */
export function aggregateEvalQueryScores(scores: EvalQueryScore[]): EvalScoreAggregate {
  const scored = scores.filter((score) => score.scorable);
  if (scored.length === 0) {
    return { query_count: 0, skipped_query_count: scores.length, recall_at_10: null, mrr: null };
  }
  const values = scored.map((score) => {
    if (score.recall_at_10 === null || score.mrr === null) {
      throw new Error("Scorable eval query is missing a score");
    }
    return { recall_at_10: score.recall_at_10, mrr: score.mrr };
  });
  const totalRecall = values.reduce((total, score) => total + score.recall_at_10, 0);
  const totalMrr = values.reduce((total, score) => total + score.mrr, 0);
  return {
    query_count: scored.length,
    skipped_query_count: scores.length - scored.length,
    recall_at_10: totalRecall / scored.length,
    mrr: totalMrr / scored.length,
  };
}

export interface ConversationCoverage {
  expected: number;
  found: number;
}

/**
 * For "every conversation about X" cases: of the distinct conversations named
 * by the case's positive expectations, how many have a hit among the first
 * `k`. Null when the case names no conversation.
 */
export function scoreConversationCoverage(
  expectations: EvalExpectation[],
  hits: EvalSearchHit[],
  k: number,
): ConversationCoverage | null {
  // A conversation id is unique only within its source, so an expectation that names a source matches only it.
  const expected = new Map<string, { source: string | null; conversationId: string }>();
  for (const expectation of expectations) {
    if (expectation.grade < 1 || expectation.conversation_id === null) continue;
    const key = JSON.stringify([expectation.source, expectation.conversation_id]);
    expected.set(key, { source: expectation.source, conversationId: expectation.conversation_id });
  }
  if (expected.size === 0) return null;
  const top = hits.slice(0, k);
  const found = [...expected.values()].filter((conversation) =>
    top.some((hit) =>
      hit.conversation_id === conversation.conversationId &&
      (conversation.source === null || hit.source === conversation.source)
    ),
  ).length;
  return { expected: expected.size, found };
}
