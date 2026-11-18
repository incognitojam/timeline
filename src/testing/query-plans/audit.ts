import type { Finding } from "./analyze";
import type { RecordedDatabase } from "./recorder";

// Intentionally far below the full backend inventory; detects a broken recorder.
export const MIN_FULL_SUITE_STATEMENTS = 100;
export const MAX_UNDER_REVIEW = 117;
interface AllowanceStatement {
  database: RecordedDatabase;
  sql: string;
  reason: string;
}
export type Allowance = AllowanceStatement & (
  | { kind: "findings"; findings: string[] }
  | { kind: "replay-error"; error: string }
);

export function parseAllowance(entry: { database: string; sql: string; reason: string } & ({ findings: string[] } | { error: string })): Allowance {
  const { database, sql, reason } = entry;
  if (database !== "timeline" && database !== "app-state") throw new Error(`Unknown allowance database: ${database}`);
  if ("error" in entry && "findings" in entry) throw new Error("An allowance must describe either findings or a replay error");
  const statement = { database, sql, reason } satisfies AllowanceStatement;
  return "error" in entry
    ? { ...statement, kind: "replay-error", error: entry.error }
    : { ...statement, kind: "findings", findings: entry.findings };
}
export interface ObservedPlan {
  database: RecordedDatabase;
  sql: string;
  origin: string;
  findings?: Finding[];
  error?: string;
}
export const findingKey = (finding: Finding): string => `${finding.table}:${finding.kind}`;
const statementKey = (entry: { database: string; sql: string }): string => `${entry.database}\0${entry.sql}`;

export function auditPlans(plans: ObservedPlan[], allowlist: { accepted: Allowance[]; underReview: Allowance[] }, fullSuite: boolean): string[] {
  if (allowlist.underReview.length > MAX_UNDER_REVIEW) throw new Error("underReview is closed: fix new scans or add them to accepted with a real reason");
  const failures: string[] = [];
  const allowed = new Map<string, Allowance>();
  for (const entry of [...allowlist.accepted, ...allowlist.underReview]) {
    if (!entry.reason.trim() || (entry.kind === "replay-error" ? !entry.error : !entry.findings.length)) throw new Error("Every query-plan allowance needs a reason and findings or a replay error");
    const key = statementKey(entry);
    if (allowed.has(key)) throw new Error("Duplicate query-plan allowance");
    allowed.set(key, entry);
  }
  const observed = new Map<string, ObservedPlan>();
  for (const plan of plans) {
    const key = statementKey(plan);
    observed.set(key, plan);
    const entry = allowed.get(key);
    const findings = [...new Set(plan.findings?.map(findingKey) ?? [])].sort();
    if (plan.error ? (entry?.kind !== "replay-error" || entry.error !== plan.error) : findings.some(finding => entry?.kind !== "findings" || !entry.findings.includes(finding))) {
      const suggestion = {
        database: plan.database, sql: plan.sql,
        reason: "Explain why this scan or replay exception is intended.",
        ...(plan.error ? { error: plan.error } : { findings }),
      };
      failures.push(`Database: ${plan.database}\n${plan.origin}\n${plan.error ?? plan.findings?.map(f => f.detail).join("\n")}\nIf intentional, use this entry in accepted (replace the reason):\n${JSON.stringify(suggestion, null, 2)}`);
    }
  }
  if (fullSuite) {
    if (plans.length < MIN_FULL_SUITE_STATEMENTS) failures.push(`Full-suite recording has only ${plans.length} distinct DML statements; expected at least ${MIN_FULL_SUITE_STATEMENTS}. Check that SQLite and DbPool instrumentation is installed.`);
    for (const [key, entry] of allowed) {
      const plan = observed.get(key);
      const current = new Set(plan?.findings?.map(findingKey));
      if (!plan || (entry.kind === "replay-error" ? entry.error !== plan.error : entry.findings.some(finding => !current.has(finding)))) {
        failures.push(`Stale allowance: remove absent statements or findings that no longer occur.\nDatabase: ${entry.database}\n${JSON.stringify(entry, null, 2)}`);
      }
    }
  }
  return failures;
}
