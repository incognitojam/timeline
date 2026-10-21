/**
 * Retrieval eval store: CRUD over eval_cases / eval_queries / eval_expectations
 * in app-state.db. Schema in app-state.ts.
 */

import type { Database } from "bun:sqlite";

export interface EvalCase {
  id: number;
  name: string;
  category: string;
  notes: string | null;
  created_at: string;
}

export interface EvalCaseSummary extends EvalCase {
  query_count: number;
  expectation_count: number;
}

export interface EvalQuery {
  id: number;
  case_id: number;
  text: string;
}

export type EvalExpectationKind = "event" | "range" | "none";

export interface EvalExpectation {
  id: number;
  case_id: number;
  kind: EvalExpectationKind;
  grade: number;
  event_id: number | null;
  source: string | null;
  event_timestamp: string | null;
  conversation_id: string | null;
  start_timestamp: string | null;
  end_timestamp: string | null;
  note: string | null;
  created_at: string;
}

export interface EvalExpectationInput {
  kind: EvalExpectationKind;
  grade?: number;
  event_id?: number;
  source?: string;
  event_timestamp?: string;
  conversation_id?: string;
  start_timestamp?: string;
  end_timestamp?: string;
  note?: string;
}

export interface EvalCaseDetail extends EvalCase {
  queries: EvalQuery[];
  expectations: EvalExpectation[];
}

function assertNonEmpty(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

/** Shape-check an expectation for its kind before it reaches SQL. */
export function validateExpectationInput(input: EvalExpectationInput): EvalExpectationInput {
  if (input.grade !== undefined && (!Number.isInteger(input.grade) || input.grade < 0 || input.grade > 2)) {
    throw new Error("grade must be 0, 1 or 2");
  }
  switch (input.kind) {
    case "event":
      if (!Number.isInteger(input.event_id) || (input.event_id ?? 0) <= 0) {
        throw new Error("event expectations require a positive event_id");
      }
      return input;
    case "range":
      assertNonEmpty(input.start_timestamp, "start_timestamp");
      assertNonEmpty(input.end_timestamp, "end_timestamp");
      return input;
    case "none":
      return input;
    default:
      throw new Error(`Unknown expectation kind: ${String(input.kind)}`);
  }
}

export function listEvalCases(db: Database): EvalCaseSummary[] {
  return db
    .prepare(
      `SELECT c.id, c.name, c.category, c.notes, c.created_at,
        (SELECT COUNT(*) FROM eval_queries q WHERE q.case_id = c.id) AS query_count,
        (SELECT COUNT(*) FROM eval_expectations e WHERE e.case_id = c.id) AS expectation_count
       FROM eval_cases c
       ORDER BY c.category, c.name`
    )
    .all() as EvalCaseSummary[];
}

export function getEvalCase(db: Database, id: number): EvalCaseDetail | null {
  const evalCase = db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(id) as EvalCase | null;
  if (!evalCase) return null;
  const queries = db
    .prepare("SELECT id, case_id, text FROM eval_queries WHERE case_id = ? ORDER BY id")
    .all(id) as EvalQuery[];
  const expectations = db
    .prepare("SELECT * FROM eval_expectations WHERE case_id = ? ORDER BY id")
    .all(id) as EvalExpectation[];
  return { ...evalCase, queries, expectations };
}

export function createEvalCase(
  db: Database,
  input: { name: string; category: string; notes?: string; queries?: string[] }
): EvalCaseDetail {
  const name = assertNonEmpty(input.name, "name");
  const category = assertNonEmpty(input.category, "category");
  const id = db.transaction(() => {
    const result = db
      .prepare("INSERT INTO eval_cases (name, category, notes) VALUES (?, ?, ?)")
      .run(name, category, input.notes?.trim() || null);
    const caseId = Number(result.lastInsertRowid);
    for (const text of input.queries ?? []) {
      addEvalQuery(db, caseId, text);
    }
    return caseId;
  })();
  const detail = getEvalCase(db, id);
  if (!detail) throw new Error(`Eval case ${id} vanished after insert`);
  return detail;
}

export function updateEvalCase(
  db: Database,
  id: number,
  input: { name?: string; category?: string; notes?: string | null }
): EvalCase | null {
  const existing = db.prepare("SELECT * FROM eval_cases WHERE id = ?").get(id) as EvalCase | null;
  if (!existing) return null;
  const name = input.name !== undefined ? assertNonEmpty(input.name, "name") : existing.name;
  const category = input.category !== undefined ? assertNonEmpty(input.category, "category") : existing.category;
  const notes = input.notes !== undefined ? (input.notes?.trim() || null) : existing.notes;
  db.prepare("UPDATE eval_cases SET name = ?, category = ?, notes = ? WHERE id = ?").run(name, category, notes, id);
  return { ...existing, name, category, notes };
}

export function deleteEvalCase(db: Database, id: number): boolean {
  return db.prepare("DELETE FROM eval_cases WHERE id = ?").run(id).changes > 0;
}

export function addEvalQuery(db: Database, caseId: number, text: string): EvalQuery {
  const trimmed = assertNonEmpty(text, "query text");
  const result = db
    .prepare("INSERT INTO eval_queries (case_id, text) VALUES (?, ?)")
    .run(caseId, trimmed);
  return { id: Number(result.lastInsertRowid), case_id: caseId, text: trimmed };
}

export function deleteEvalQuery(db: Database, id: number): boolean {
  return db.prepare("DELETE FROM eval_queries WHERE id = ?").run(id).changes > 0;
}

export function addEvalExpectation(db: Database, caseId: number, input: EvalExpectationInput): EvalExpectation {
  const valid = validateExpectationInput(input);
  const result = db
    .prepare(
      `INSERT INTO eval_expectations
        (case_id, kind, grade, event_id, source, event_timestamp, conversation_id, start_timestamp, end_timestamp, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      caseId,
      valid.kind,
      valid.grade ?? 2,
      valid.event_id ?? null,
      valid.source ?? null,
      valid.event_timestamp ?? null,
      valid.conversation_id ?? null,
      valid.start_timestamp ?? null,
      valid.end_timestamp ?? null,
      valid.note?.trim() || null
    );
  const row = db
    .prepare("SELECT * FROM eval_expectations WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as EvalExpectation | null;
  if (!row) throw new Error("Eval expectation vanished after insert");
  return row;
}

export function updateEvalExpectation(
  db: Database,
  id: number,
  input: { grade?: number; note?: string | null }
): EvalExpectation | null {
  const existing = db.prepare("SELECT * FROM eval_expectations WHERE id = ?").get(id) as EvalExpectation | null;
  if (!existing) return null;
  if (input.grade !== undefined && (!Number.isInteger(input.grade) || input.grade < 0 || input.grade > 2)) {
    throw new Error("grade must be 0, 1 or 2");
  }
  const grade = input.grade ?? existing.grade;
  const note = input.note !== undefined ? (input.note?.trim() || null) : existing.note;
  db.prepare("UPDATE eval_expectations SET grade = ?, note = ? WHERE id = ?").run(grade, note, id);
  return { ...existing, grade, note };
}

export function deleteEvalExpectation(db: Database, id: number): boolean {
  return db.prepare("DELETE FROM eval_expectations WHERE id = ?").run(id).changes > 0;
}
