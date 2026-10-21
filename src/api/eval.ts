/**
 * Retrieval eval API
 *
 * CRUD over labelled search-quality test cases (app-state.db). The /eval page
 * uses this to build and grade the test set; scoring runs consume it later.
 */

import { Hono } from "hono";
import { getAppStateDb } from "../db/app-state";
import {
  addEvalExpectation,
  addEvalQuery,
  createEvalCase,
  deleteEvalCase,
  deleteEvalExpectation,
  deleteEvalQuery,
  type EvalExpectationInput,
  getEvalCase,
  listEvalCases,
  updateEvalCase,
  updateEvalExpectation,
} from "../db/eval";

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const evalRoutes = new Hono()
  .get("/api/eval/cases", (c) => {
    const cases = listEvalCases(getAppStateDb());
    return c.json({ cases, count: cases.length });
  })

  .post("/api/eval/cases", async (c) => {
    const body = await c.req.json<{ name?: string; category?: string; notes?: string; queries?: string[] }>();
    try {
      const created = createEvalCase(getAppStateDb(), {
        name: body.name ?? "",
        category: body.category ?? "",
        notes: body.notes,
        queries: body.queries,
      });
      return c.json({ case: created }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: `An eval case named "${body.name}" already exists` }, 409);
      }
      return c.json({ error: errorMessage(error) }, 400);
    }
  })

  .get("/api/eval/cases/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid case id" }, 400);
    const detail = getEvalCase(getAppStateDb(), id);
    if (!detail) return c.json({ error: "Eval case not found" }, 404);
    return c.json({ case: detail });
  })

  .patch("/api/eval/cases/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid case id" }, 400);
    const body = await c.req.json<{ name?: string; category?: string; notes?: string | null }>();
    try {
      const updated = updateEvalCase(getAppStateDb(), id, body);
      if (!updated) return c.json({ error: "Eval case not found" }, 404);
      return c.json({ case: updated });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: `An eval case named "${body.name}" already exists` }, 409);
      }
      return c.json({ error: errorMessage(error) }, 400);
    }
  })

  .delete("/api/eval/cases/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid case id" }, 400);
    if (!deleteEvalCase(getAppStateDb(), id)) return c.json({ error: "Eval case not found" }, 404);
    return c.json({ deleted: true });
  })

  .post("/api/eval/cases/:id/queries", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid case id" }, 400);
    const db = getAppStateDb();
    if (!getEvalCase(db, id)) return c.json({ error: "Eval case not found" }, 404);
    const body = await c.req.json<{ text?: string }>();
    try {
      return c.json({ query: addEvalQuery(db, id, body.text ?? "") }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return c.json({ error: "This case already has that query" }, 409);
      }
      return c.json({ error: errorMessage(error) }, 400);
    }
  })

  .delete("/api/eval/queries/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid query id" }, 400);
    if (!deleteEvalQuery(getAppStateDb(), id)) return c.json({ error: "Eval query not found" }, 404);
    return c.json({ deleted: true });
  })

  .post("/api/eval/cases/:id/expectations", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid case id" }, 400);
    const db = getAppStateDb();
    if (!getEvalCase(db, id)) return c.json({ error: "Eval case not found" }, 404);
    const body = await c.req.json<EvalExpectationInput>();
    try {
      return c.json({ expectation: addEvalExpectation(db, id, body) }, 201);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  })

  .patch("/api/eval/expectations/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid expectation id" }, 400);
    const body = await c.req.json<{ grade?: number; note?: string | null }>();
    try {
      const updated = updateEvalExpectation(getAppStateDb(), id, body);
      if (!updated) return c.json({ error: "Eval expectation not found" }, 404);
      return c.json({ expectation: updated });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 400);
    }
  })

  .delete("/api/eval/expectations/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid expectation id" }, 400);
    if (!deleteEvalExpectation(getAppStateDb(), id)) return c.json({ error: "Eval expectation not found" }, 404);
    return c.json({ deleted: true });
  });
