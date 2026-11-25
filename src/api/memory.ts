/**
 * Shared agent memory, for the web page: browse, edit, delete and restore the
 * notes agents save over MCP. Checks and caps are the store's, shared with the MCP tools.
 */

import { type Context, Hono } from "hono";
import { getAppStateDb } from "../db/app-state";
import {
  deleteMemoryNote,
  getMemoryNote,
  listMemoryVersions,
  memoryIndex,
  restoreMemoryVersion,
  setProjectUsesAccountMemory,
  updateMemoryNote,
} from "../db/memory-notes";
import type { Database } from "../db/sqlite";

const EDITABLE = ["kind", "title", "summary", "details"] as const;

/** The note a request names: `:name` in the scope of `?project=` (the account when absent). */
function scope(c: Context) {
  return { project: c.req.query("project") ?? "", name: c.req.param("name") ?? "" };
}

function refused(c: Context, error: unknown) {
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
}

export function createMemoryRoutes(db: () => Database = getAppStateDb) {
  return new Hono()
    .get("/api/memory", (c) => c.json(memoryIndex(db())))

    .get("/api/memory/notes/:name", (c) => {
      const { project, name } = scope(c);
      const note = getMemoryNote(db(), project, name);
      if (!note) return c.json({ error: "Note not found" }, 404);
      return c.json({ note });
    })

    .patch("/api/memory/notes/:name", async (c) => {
      const { project, name } = scope(c);
      const body: unknown = await c.req.json().catch(() => null);
      if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: "Expected a JSON object" }, 400);
      const fields: Partial<Record<(typeof EDITABLE)[number], string>> = {};
      for (const field of EDITABLE) {
        const value = (body as Record<string, unknown>)[field];
        if (value === undefined) continue;
        if (typeof value !== "string") return c.json({ error: `${field} must be a string` }, 400);
        fields[field] = value;
      }
      try {
        const note = updateMemoryNote(db(), { project, name, ...fields });
        if (!note) return c.json({ error: "Note not found" }, 404);
        return c.json({ note });
      } catch (error) {
        return refused(c, error);
      }
    })

    .delete("/api/memory/notes/:name", (c) => {
      const { project, name } = scope(c);
      if (!deleteMemoryNote(db(), project, name)) return c.json({ error: "Note not found" }, 404);
      return c.json({ ok: true });
    })

    .get("/api/memory/notes/:name/versions", (c) => {
      const { project, name } = scope(c);
      return c.json({ versions: listMemoryVersions(db(), project, name) });
    })

    .post("/api/memory/versions/:id/restore", (c) => {
      const id = Number(c.req.param("id"));
      try {
        const restored = Number.isInteger(id) ? restoreMemoryVersion(db(), id) : null;
        if (!restored) return c.json({ error: "Version not found" }, 404);
        return c.json({ note: restored.note });
      } catch (error) {
        return refused(c, error);
      }
    })

    .put("/api/memory/projects/:project", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { useAccountMemory?: unknown } | null;
      if (typeof body?.useAccountMemory !== "boolean") return c.json({ error: "useAccountMemory must be a boolean" }, 400);
      try {
        setProjectUsesAccountMemory(db(), c.req.param("project"), body.useAccountMemory);
      } catch (error) {
        return refused(c, error);
      }
      return c.json({ ok: true });
    });
}
