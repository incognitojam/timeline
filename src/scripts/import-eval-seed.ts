/**
 * Import a retrieval-eval seed fixture (JSON) into app-state.db eval tables.
 *
 * Usage: bun run src/scripts/import-eval-seed.ts <fixture.json>
 * On the host, point at the live DB: TIMELINE_DB_PATH=~/.local/share/timeline/timeline.db
 *
 * Idempotent: cases whose name already exists are skipped, so re-runs are safe.
 * Fixture `filter` expectations (aggregate targets like an artist-month) import
 * as ranges with the filter detail in the note; `todo` cases import with no
 * expectations, to be labelled in the /eval UI.
 */

import { readFileSync } from "node:fs";
import { getAppStateDb } from "../db/app-state";
import { addEvalExpectation, createEvalCase, listEvalCases } from "../db/eval";

interface FixtureEventRef {
  id: number;
  source: string;
  timestamp: string;
  grade?: number;
  desc?: string;
}

interface FixtureRange {
  source?: string;
  conversation_id?: string;
  start: string;
  end: string;
  grade?: number;
  anchor_id?: number;
}

interface FixtureFilter {
  source: string;
  start: string;
  end: string;
  grade?: number;
  [key: string]: unknown;
}

interface FixtureCase {
  id: string;
  category: string;
  queries: string[];
  notes?: string;
  status?: string;
  expect: {
    events?: FixtureEventRef[];
    range?: FixtureRange;
    filter?: FixtureFilter;
    none?: boolean;
    todo?: string;
  };
}

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error("Usage: bun run src/scripts/import-eval-seed.ts <fixture.json>");
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: FixtureCase[] };
if (!Array.isArray(fixture.cases)) {
  throw new Error("Fixture has no cases array");
}

const db = getAppStateDb();
const existingNames = new Set(listEvalCases(db).map((c) => c.name));

let imported = 0;
let skipped = 0;

for (const fixtureCase of fixture.cases) {
  if (existingNames.has(fixtureCase.id)) {
    skipped++;
    continue;
  }

  const noteParts = [fixtureCase.notes, fixtureCase.status ? `Status: ${fixtureCase.status}` : null, fixtureCase.expect.todo ? `TODO: ${fixtureCase.expect.todo}` : null];
  const created = createEvalCase(db, {
    name: fixtureCase.id,
    category: fixtureCase.category,
    notes: noteParts.filter(Boolean).join("\n") || undefined,
    queries: fixtureCase.queries,
  });

  for (const event of fixtureCase.expect.events ?? []) {
    addEvalExpectation(db, created.id, {
      kind: "event",
      event_id: event.id,
      source: event.source,
      event_timestamp: event.timestamp,
      grade: event.grade,
      note: event.desc,
    });
  }

  const range = fixtureCase.expect.range;
  if (range) {
    addEvalExpectation(db, created.id, {
      kind: "range",
      source: range.source,
      conversation_id: range.conversation_id,
      start_timestamp: range.start,
      end_timestamp: range.end,
      grade: range.grade,
      note: range.anchor_id ? `anchor event #${range.anchor_id}` : undefined,
    });
  }

  const filter = fixtureCase.expect.filter;
  if (filter) {
    const detail = Object.entries(filter)
      .filter(([key]) => !["source", "start", "end", "grade"].includes(key))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(", ");
    addEvalExpectation(db, created.id, {
      kind: "range",
      source: filter.source,
      start_timestamp: filter.start,
      end_timestamp: filter.end,
      grade: filter.grade,
      note: `filter target: ${detail}`,
    });
  }

  if (fixtureCase.expect.none) {
    addEvalExpectation(db, created.id, { kind: "none", grade: 0, note: "negative control" });
  }

  imported++;
}

console.log(JSON.stringify({ imported, skipped, total: fixture.cases.length }));
