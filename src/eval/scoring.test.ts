import { describe, expect, it } from "bun:test";
import type { EvalExpectation } from "../db/eval";
import { aggregateEvalQueryScores, matchesEvalExpectation, scoreEvalQuery } from "./scoring";

function expectation(overrides: Partial<EvalExpectation>): EvalExpectation {
  return {
    id: 1,
    case_id: 1,
    kind: "event",
    grade: 2,
    event_id: 1,
    source: null,
    event_timestamp: null,
    conversation_id: null,
    start_timestamp: null,
    end_timestamp: null,
    note: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("retrieval eval scoring", () => {
  it("matches an expected event and scores its grade-2 rank", () => {
    const score = scoreEvalQuery([expectation({ event_id: 42 })], [
      { event_id: 9, conversation_id: null, timestamp: null },
      { event_id: 42, conversation_id: null, timestamp: null },
    ]);

    expect(score).toMatchObject({
      recall_at_10: 1,
      mrr: 0.5,
      first_grade_2_rank: 2,
      negatives_retrieved: 0,
    });
  });

  it("matches a range by conversation id", () => {
    const range = expectation({
      kind: "range",
      event_id: null,
      conversation_id: "conversation-1",
      start_timestamp: "2026-01-01T00:00:00Z",
      end_timestamp: "2026-01-01T01:00:00Z",
    });

    expect(matchesEvalExpectation(range, {
      event_id: 2,
      conversation_id: "conversation-1",
      timestamp: "2025-01-01T00:00:00Z",
    })).toBe(true);
  });

  it("matches a range by timestamp window", () => {
    const range = expectation({
      kind: "range",
      event_id: null,
      conversation_id: null,
      start_timestamp: "2026-01-01T00:00:00Z",
      end_timestamp: "2026-01-01T01:00:00Z",
    });

    expect(matchesEvalExpectation(range, {
      event_id: 2,
      conversation_id: null,
      timestamp: "2026-01-01T00:30:00Z",
    })).toBe(true);
  });

  it("keeps none expectations scorable based on positive matches", () => {
    const none = expectation({ kind: "none", grade: 0, event_id: null });
    expect(scoreEvalQuery([none], [{ event_id: 7, conversation_id: null, timestamp: null }])).toMatchObject({
      recall_at_10: 1,
      none_score: 1,
    });

    const positive = expectation({ id: 2, event_id: 7, grade: 1 });
    expect(scoreEvalQuery([none, positive], [{ event_id: 7, conversation_id: null, timestamp: null }])).toMatchObject({
      recall_at_10: 1,
      none_score: 0,
    });
  });

  it("marks queries without expectations as unlabelled and unscorable", () => {
    expect(scoreEvalQuery([], [{ event_id: 7, conversation_id: null, timestamp: null }])).toMatchObject({
      scorable: false,
      skip_reason: "unlabelled",
      recall_at_10: null,
      mrr: null,
    });
  });

  it("averages only scored queries", () => {
    const scored = scoreEvalQuery([expectation({ event_id: 7 })], [
      { event_id: 7, conversation_id: null, timestamp: null },
    ]);
    const unlabelled = scoreEvalQuery([], []);

    expect(aggregateEvalQueryScores([scored, unlabelled])).toEqual({
      query_count: 1,
      skipped_query_count: 1,
      recall_at_10: 1,
      mrr: 1,
    });
  });

  it("counts retrieved grade-0 expectations", () => {
    const negative = expectation({ grade: 0, event_id: 3 });
    expect(scoreEvalQuery([negative], [{ event_id: 3, conversation_id: null, timestamp: null }])).toMatchObject({
      negatives_retrieved: 1,
    });
  });

  it("reports zero MRR without a grade-2 hit", () => {
    const partial = expectation({ grade: 1, event_id: 3 });
    expect(scoreEvalQuery([partial], [{ event_id: 3, conversation_id: null, timestamp: null }])).toMatchObject({
      recall_at_10: 1,
      mrr: 0,
      first_grade_2_rank: null,
    });
  });
});
