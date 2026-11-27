/**
 * Shared agent memory, for the web page: browse, edit, delete and restore the
 * notes agents save over MCP. Checks and caps are the store's, shared with the MCP tools.
 */

import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAppStateDb } from "../db/app-state";
import {
  deleteMemoryNote,
  getMemoryNote,
  importMemoryNotes,
  type MemoryImportPlan,
  planMemoryImport,
  listMemoryVersions,
  memoryIndex,
  restoreMemoryVersion,
  setProjectUsesAccountMemory,
  updateMemoryNote,
} from "../db/memory-notes";
import type { QueryExecutor } from "../db/pool";
import type { Database } from "../db/sqlite";
import { type ClaudeMemoryNote, MEMORY_EXPORT_MAX_BYTES, mapClaudeMemory, readClaudeMemoryUpload } from "../platforms/claude/memory-import";
import type { MemoryImportResult } from "../shared/memory";

const EDITABLE = ["kind", "title", "summary", "details"] as const;

/** The note a request names: `:name` in the scope of `?project=` (the account when absent). */
function scope(c: Context) {
  return { project: c.req.query("project") ?? "", name: c.req.param("name") ?? "" };
}

function refused(c: Context, error: unknown) {
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
}

/**
 * Link each person note to the contact whose name its title or an alias is,
 * ignoring case, only when those names point at exactly one contact.
 * Returns each linked contact's name by id.
 */
async function linkContacts(contacts: QueryExecutor, notes: ClaudeMemoryNote[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  for (const note of notes) {
    if (note.kind !== "person") continue;
    const candidates = [note.title, ...note.aliases].slice(0, 50);
    const rows = await contacts.query<{ id: number; display_name: string }>(
      "SELECT id, display_name FROM contacts WHERE display_name COLLATE NOCASE IN (SELECT value FROM json_each(?))",
      JSON.stringify(candidates),
    );
    if (new Set(rows.map((row) => row.id)).size !== 1) continue;
    note.contactId = rows[0].id;
    names.set(rows[0].id, rows[0].display_name);
  }
  return names;
}

/** What a plan adds, for Import to check that memory has not changed since the preview. */
const planId = (plan: MemoryImportPlan) =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(plan.add.map((note) => [note.project, note.name, note.kind, note.contactId])))
    .digest("hex")
    .slice(0, 16);

function importResult(plan: MemoryImportPlan, problems: MemoryImportResult["problems"], contactNames: Map<number, string>, imported: boolean): MemoryImportResult {
  const add = new Map<string, MemoryImportResult["add"][number]>();
  for (const note of plan.add) {
    const key = `${note.project}/${note.kind}`;
    const group = add.get(key) ?? { project: note.project, kind: note.kind as MemoryImportResult["add"][number]["kind"], count: 0 };
    group.count++;
    add.set(key, group);
  }
  return {
    imported,
    planId: planId(plan),
    add: [...add.values()],
    links: plan.add.flatMap((note) =>
      note.contactId === null ? [] : [{ project: note.project, name: note.name, contact: contactNames.get(note.contactId) ?? "" }]),
    existing: plan.existing.length,
    problems: [...problems, ...plan.problems],
    overLimit: plan.overLimit,
  };
}

/** `contacts` is timeline.db, for linking imported person notes to contacts. */
export function createMemoryRoutes(contacts: QueryExecutor, db: () => Database = getAppStateDb) {
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

    // An upload of claude.ai's claude-memory-<date>.zip or memories-000.zip (or its JSON): a preview, or with ?plan=<planId> from that preview, the import.
    .post(
      "/api/memory/import",
      bodyLimit({
        maxSize: MEMORY_EXPORT_MAX_BYTES,
        onError: (c) => c.json({ error: `The upload is larger than ${MEMORY_EXPORT_MAX_BYTES / 1024 / 1024} MiB.` }, 413),
      }),
      async (c) => {
        // Only the web app's own page may upload: a cross-site or same-site form or fetch is refused.
        const site = c.req.header("Sec-Fetch-Site");
        if ((site !== undefined && site !== "same-origin") || c.req.header("Content-Type") !== "application/octet-stream") {
          return c.json({ error: "Upload from the Memory page." }, 403);
        }
        const expected = c.req.query("plan");
        try {
          const upload = await readClaudeMemoryUpload(new Uint8Array(await c.req.arrayBuffer()));
          const mapped = mapClaudeMemory(upload.files);
          const notes = mapped.notes;
          const problems = [...upload.problems, ...mapped.problems];
          const contactNames = await linkContacts(contacts, notes);
          if (expected === undefined) return c.json(importResult(planMemoryImport(db(), notes), problems, contactNames, false));
          const plan = importMemoryNotes(db(), notes, (fresh) => {
            if (planId(fresh) !== expected) throw new Error("Memory has changed since the preview. Choose the file again to see what the import would add now.");
          });
          return c.json(importResult(plan, problems, contactNames, true));
        } catch (error) {
          return refused(c, error);
        }
      },
    )

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
