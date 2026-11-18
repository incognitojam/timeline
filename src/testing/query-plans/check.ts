import { readFileSync } from "node:fs";
import { Database } from "../../db/sqlite";
import { configureBunSqliteForSqliteVec } from "../../embeddings/sqlite-vec";
import { initDb } from "../../db/schema";
import { initAppStateDb } from "../../db/app-state";
import { explain } from "./analyze";
import { auditPlans, parseAllowance } from "./audit";
import { statements } from "./sql";
import type { QueryRecording } from "./recorder";
import { validateTablePolicy } from "./policy";
import allowlist from "./allowlist.json";

const input = process.argv[2];
if (!input || process.argv.length > 3) throw new Error("Usage: check.ts recording.json");
const recording = JSON.parse(readFileSync(input, "utf8")) as QueryRecording;
configureBunSqliteForSqliteVec();
const databases = { timeline: new Database(":memory:"), "app-state": new Database(":memory:") };
initDb(databases.timeline);
databases["app-state"].exec("PRAGMA foreign_keys = ON");
initAppStateDb(databases["app-state"]);
const tables = new Set(Object.values(databases).flatMap(db =>
  (db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name)));
validateTablePolicy(tables);
const seen = new Set<string>();
const plans = [];
for (const record of recording.records) {
  for (const sql of statements(record.sql)) {
    const key = `${record.database}\0${sql}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!/^(SELECT|WITH|INSERT|REPLACE|UPDATE|DELETE)\b/i.test(sql)) continue;
    try {
      const plan = explain(databases[record.database], sql);
      plans.push({ ...record, sql, ...plan });
    } catch (error) {
      // Temporary/attached tables and old-schema migrations are explicit replay gaps.
      plans.push({ ...record, sql, error: String(error) });
    }
  }
}
const failures = auditPlans(plans, { accepted: allowlist.accepted.map(parseAllowance), underReview: allowlist.underReview.map(parseAllowance) }, recording.fullSuite === true);
failures.push(...recording.collectionErrors.map(error => `Recorder could not collect SQL: ${error}`));
for (const db of Object.values(databases)) db.close();
if (failures.length) {
  console.error(`Query-plan check failed. Add an index or rewrite the query; if a scan is intended, add it to accepted in src/testing/query-plans/allowlist.json with a real reason. The historical underReview inventory is closed: do not add new entries. Investigate replay/recorder errors rather than masking them.\n\n${failures.join("\n\n")}`);
  process.exitCode = 1;
}
