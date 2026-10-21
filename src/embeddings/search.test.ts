import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SEARCH_EXCLUDED_SOURCES,
  getSemanticSearchCandidateIds,
  postProcessSemanticSearch,
} from "./search";

describe("semantic search post-processing", () => {
  it("keeps the nearest document distance per event and filters default-excluded sources", () => {
    const hits = [
      { document_id: 11, event_id: 1, distance: 0.7 },
      { document_id: 12, event_id: 2, distance: 0.2 },
      { document_id: 13, event_id: 1, distance: 0.1 },
      { document_id: 14, event_id: 3, distance: 0.3 },
    ];
    const candidates = [
      { id: 1, source: "discord" },
      { id: 2, source: "codex" },
      { id: 3, source: "spotify" },
    ];

    expect(getSemanticSearchCandidateIds(hits)).toEqual([1, 2, 3]);
    expect(postProcessSemanticSearch(hits, candidates, new Set(DEFAULT_SEARCH_EXCLUDED_SOURCES), 10)).toEqual([
      { id: 1, source: "discord", distance: 0.1 },
      { id: 3, source: "spotify", distance: 0.3 },
    ]);
  });
});
