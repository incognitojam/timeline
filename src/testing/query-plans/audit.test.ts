import { expect, test } from "bun:test";
import { auditPlans, parseAllowance, type Allowance, MAX_UNDER_REVIEW, MIN_FULL_SUITE_STATEMENTS, type ObservedPlan } from "./audit";
import { LARGE_TABLES, SMALL_TABLES, validateTablePolicy } from "./policy";

const plan: ObservedPlan = { database: "timeline", sql: "SELECT * FROM events", origin: "synthetic", findings: [{ table: "events", kind: "index-scan", detail: "SCAN events USING COVERING INDEX linux_choice" }] };
const allowance: Allowance = { database: plan.database, sql: plan.sql, reason: "An intentional complete export", kind: "findings", findings: ["events:index-scan"] };
const full = Array.from({ length: MIN_FULL_SUITE_STATEMENTS }, (_, i) => ({ ...plan, sql: `SELECT ${i}`, findings: [] }));

test("allowances ignore SQLite wording/index choice but keep table and kind", () => {
  expect(auditPlans([plan], { accepted: [allowance], underReview: [] }, false)).toEqual([]);
  expect(auditPlans([{ ...plan, findings: [{ table: "events", kind: "index-scan", detail: "SCAN events USING INDEX macos_choice" }] }], { accepted: [allowance], underReview: [] }, false)).toEqual([]);
  for (const findings of [
    [{ table: "events", kind: "table-scan" as const, detail: "SCAN events" }],
    [{ table: "attachments", kind: "index-scan" as const, detail: "SCAN attachments USING INDEX another" }],
  ]) expect(auditPlans([{ ...plan, findings }], { accepted: [allowance], underReview: [] }, false)).toHaveLength(1);
});

test("only full runs reject absent allowances, vanished findings, and low counts", () => {
  expect(auditPlans([], { accepted: [allowance], underReview: [] }, false)).toEqual([]);
  expect(auditPlans(full, { accepted: [allowance], underReview: [] }, true).join("\n")).toContain("Stale allowance");
  expect(auditPlans([...full, { ...plan, findings: [] }], { accepted: [allowance], underReview: [] }, true).join("\n")).toContain("Stale allowance");
  expect(auditPlans([...full, plan], { accepted: [allowance], underReview: [] }, true)).toEqual([]);
  expect(auditPlans([], { accepted: [], underReview: [] }, true).join("\n")).toContain(`expected at least ${MIN_FULL_SUITE_STATEMENTS}`);
  const replayAllowance: Allowance = { database: plan.database, sql: plan.sql, reason: "Old schema migration", kind: "replay-error", error: "SQLiteError: no such table: old" };
  expect(auditPlans([...full, { ...plan, findings: [] }], { accepted: [replayAllowance], underReview: [] }, true).join("\n")).toContain("Stale allowance");
});

test("diagnostics name the database and provide a ready-to-paste semantic allowance", () => {
  const failure = auditPlans([plan], { accepted: [], underReview: [] }, false).join("\n");
  expect(failure).toContain("Database: timeline");
  const entry = JSON.parse(failure.slice(failure.indexOf("{\n")));
  expect(entry).toMatchObject({ database: "timeline", sql: plan.sql, findings: ["events:index-scan"] });
  expect(entry.findings.join()).not.toContain("linux_choice");
});

test("table policy rejects overlap, missing names and unclassified new tables", () => {
  const tables = new Set([...LARGE_TABLES, ...Object.keys(SMALL_TABLES)]);
  expect(() => validateTablePolicy(tables)).not.toThrow();
  expect(() => validateTablePolicy(new Set([...tables, "new_history"]))).toThrow();
  const withoutEvents = new Set(tables);
  withoutEvents.delete("events");
  expect(() => validateTablePolicy(withoutEvents)).toThrow("Remove missing table events");
  SMALL_TABLES.events = "synthetic overlap";
  try { expect(() => validateTablePolicy(tables)).toThrow("both large and small"); }
  finally { delete SMALL_TABLES.events; }
});

test("the historical inventory cannot grow beyond its cap", () => {
  expect(() => auditPlans([], { accepted: [], underReview: Array(MAX_UNDER_REVIEW + 1).fill(allowance) }, false)).toThrow("underReview is closed");
  expect(auditPlans([plan], { accepted: [], underReview: [allowance] }, false)).toEqual([]);
});

test("JSON allowances distinguish scans from replay errors and validate database names", () => {
  const statement = { database: "timeline", sql: "SELECT * FROM old", reason: "Old schema migration" };
  const replay = parseAllowance({ ...statement, error: "SQLiteError: no such table: old" });
  expect(replay.kind).toBe("replay-error");
  expect(auditPlans([{ ...plan, sql: statement.sql, error: "SQLiteError: no such table: old" }], { accepted: [replay], underReview: [] }, false)).toEqual([]);
  expect(parseAllowance({ ...statement, findings: ["events:table-scan"] }).kind).toBe("findings");
  expect(() => parseAllowance({ ...statement, database: "typo", findings: [] })).toThrow("Unknown allowance database");
  expect(() => parseAllowance({ ...statement, error: "old", findings: [] })).toThrow("either findings or a replay error");
});
