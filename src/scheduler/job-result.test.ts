import { describe, expect, test } from "bun:test";
import { syncJobResult } from "./job-result";

describe("syncJobResult", () => {
  test("carries skipped through for deferred sync jobs", () => {
    expect(syncJobResult({
      source: "scheduler-test-deferred",
      success: true,
      skipped: true,
      eventsAdded: 0,
      eventsUpdated: 0,
      durationMs: 5,
      metadata: { skipReason: "blocked network" },
    })).toEqual({
      source: "scheduler-test-deferred",
      skipped: true,
      eventsAdded: 0,
      eventsUpdated: 0,
      durationMs: 5,
      metadata: { skipReason: "blocked network" },
    });
  });

  test("sets skipped false for ordinary successful sync jobs", () => {
    expect(syncJobResult({
      source: "scheduler-test-success",
      success: true,
      eventsAdded: 3,
      eventsUpdated: 1,
      durationMs: 25,
    })).toEqual({
      source: "scheduler-test-success",
      skipped: false,
      eventsAdded: 3,
      eventsUpdated: 1,
      durationMs: 25,
      metadata: null,
    });
  });
});
