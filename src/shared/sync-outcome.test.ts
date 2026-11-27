import { Database } from "../db/sqlite";
import { expect, test } from "bun:test";
import { FOUND_NOTHING_NEW_SQL, foundNothingNew } from "./sync-outcome";

test("the SQL and TypeScript rules agree on every metadata shape", () => {
  const db = new Database(":memory:");
  const cases: [string | null, boolean][] = [
    ['{"skipReason":"No new DM messages","requests":1}', true],
    ['{"requests":0}', false],
    ['{"requests":"1"}', false],
    ['{"requests":true}', false],
    ['{"requests":{}}', false],
    ['{"guard":"network","skipReason":"offline"}', false],
    ["not json", false],
    [null, false],
  ];
  for (const [metadata, expected] of cases) {
    const row = db.prepare(`SELECT ${FOUND_NOTHING_NEW_SQL} AS quiet FROM (SELECT 1 AS skipped, ? AS metadata)`).get(metadata) as { quiet: number };
    expect([metadata, foundNothingNew(1, metadata)]).toEqual([metadata, expected]);
    expect([metadata, row.quiet === 1]).toEqual([metadata, expected]);
  }
});
