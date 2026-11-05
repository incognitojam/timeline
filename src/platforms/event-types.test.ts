import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TRANSPORT_MODES } from "../db/manual-events";
import { SEED_SOURCES } from "../seed/sources";
import { DECLARED_SOURCES } from "../shared/sources";
import { undeclaredEventPairs, undeclaredSeedPairs, unusedDeclarations } from "./event-types";

const SOURCES = [
  { id: "alpha", label: "Alpha", eventTypes: ["alpha:post", "alpha:reaction:*"], legacyEventTypes: ["alpha:old"] },
  { id: "beta", label: "Beta" },
];

let db: Database;

function addEvents(...pairs: [string, string][]) {
  const insert = db.prepare("INSERT INTO events (source, type) VALUES (?, ?)");
  for (const [source, type] of pairs) insert.run(source, type);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run("CREATE TABLE events (source TEXT, type TEXT)");
});

afterEach(() => db.close());

describe("undeclaredEventPairs", () => {
  test("accepts current, wildcard and legacy types", () => {
    addEvents(["alpha", "alpha:post"], ["alpha", "alpha:reaction:wow"], ["alpha", "alpha:old"]);
    expect(undeclaredEventPairs(db, SOURCES)).toEqual([]);
  });

  test("reports unknown types and sources with their counts", () => {
    addEvents(["alpha", "alpha:new"], ["alpha", "alpha:new"], ["gamma", "gamma:post"]);
    expect(undeclaredEventPairs(db, SOURCES)).toEqual([
      { source: "alpha", type: "alpha:new", count: 2 },
      { source: "gamma", type: "gamma:post", count: 1 },
    ]);
  });

  test("does not let a wildcard match its prefix's siblings", () => {
    addEvents(["alpha", "alpha:reactions"]);
    expect(undeclaredEventPairs(db, SOURCES).map((pair) => pair.type)).toEqual(["alpha:reactions"]);
  });

  test("reports types on a source that declares none", () => {
    addEvents(["beta", "beta:post"]);
    expect(undeclaredEventPairs(db, SOURCES)).toEqual([{ source: "beta", type: "beta:post", count: 1 }]);
  });
});

describe("unusedDeclarations", () => {
  test("lists declarations with no rows and marks legacy ones", () => {
    addEvents(["alpha", "alpha:reaction:wow"]);
    expect(unusedDeclarations(db, SOURCES)).toEqual([
      { source: "alpha", type: "alpha:post", legacy: false },
      { source: "alpha", type: "alpha:old", legacy: true },
    ]);
  });
});

describe("undeclaredSeedPairs", () => {
  const seed = (produces: Record<string, string[]>) => ({ name: "gen", produces, seed: async () => {} });

  test("requires current declarations, not legacy ones", () => {
    expect(undeclaredSeedPairs([seed({ alpha: ["alpha:post", "alpha:reaction:wow"] })], SOURCES)).toEqual([]);
    expect(undeclaredSeedPairs([seed({ alpha: ["alpha:old"], gamma: ["x"] })], SOURCES)).toEqual([
      "gen: alpha/alpha:old",
      "gen: gamma/x",
    ]);
  });

  test("every real generator produces only declared types", () => {
    expect(undeclaredSeedPairs(SEED_SOURCES)).toEqual([]);
  });
});

test("manual events declare every transport mode", () => {
  const manual = DECLARED_SOURCES.find((source) => source.id === "manual");
  const declared = manual?.eventTypes?.filter((type) => type.startsWith("transport:"));
  expect(declared).toEqual(TRANSPORT_MODES.map((mode) => `transport:${mode}`));
});
