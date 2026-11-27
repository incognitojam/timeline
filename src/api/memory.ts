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
  type ImportedMemoryNote,
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
import {
  type MemoryContactMatch,
  type MemoryImportContact,
  type MemoryImportNote,
  type MemoryImportResult,
  type MemoryKind,
} from "../shared/memory";

const EDITABLE = ["kind", "title", "summary", "details"] as const;

/** The note a request names: `:name` in the scope of `?project=` (the account when absent). */
function scope(c: Context) {
  return { project: c.req.query("project") ?? "", name: c.req.param("name") ?? "" };
}

function refused(c: Context, error: unknown) {
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
}

type Contact = MemoryImportContact;

/** Contacts by id, hidden ones included: the owner's session may link a note to one, which keeps the note from agents. */
const CONTACT_COLUMNS = "id, display_name AS name, hidden";
const contactRow = (row: { id: number; name: string; hidden: number }): Contact => ({ id: row.id, name: row.name, hidden: row.hidden === 1 });
type PersonMatch = { aliases: string[]; match: MemoryContactMatch; contact: Contact | null };

/**
 * Link each person note to the contact whose name its title or an alias is,
 * ignoring case, only when those names point at exactly one contact, hidden
 * ones included. Returns how each person note matched.
 */
async function matchContacts(contacts: QueryExecutor, notes: ClaudeMemoryNote[]): Promise<Map<ClaudeMemoryNote, PersonMatch>> {
  const matches = new Map<ClaudeMemoryNote, PersonMatch>();
  for (const note of notes) {
    if (note.kind !== "person") continue;
    // At most 49 aliases are matched, and only those are reported.
    const aliases = note.aliases.slice(0, 49);
    const candidates = [note.title, ...aliases];
    const rows = (await contacts.query<{ id: number; name: string; hidden: number }>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE display_name COLLATE NOCASE IN (SELECT value FROM json_each(?))`,
      JSON.stringify(candidates),
    )).map(contactRow);
    const count = new Set(rows.map((row) => row.id)).size;
    if (count !== 1) {
      const hidden = new Set(rows.filter((row) => row.hidden).map((row) => row.id)).size;
      matches.set(note, { aliases, match: count === 0 ? { by: "none" } : { by: "several", count, hidden }, contact: null });
      continue;
    }
    const [contact] = rows;
    note.contactId = contact.id;
    const same = (name: string) => name.toLowerCase() === contact.name.toLowerCase();
    const alias = aliases.find(same);
    matches.set(note, { aliases, match: same(note.title) || alias === undefined ? { by: "title" } : { by: "alias", alias }, contact });
  }
  return matches;
}

/** The owner's contact choices from Import's `links` parameter, one per person the preview listed, each a contact or null. */
async function chosenLinks(contacts: QueryExecutor, raw: string | undefined): Promise<(Contact | null)[]> {
  const invalid = new Error("Import needs the contact chosen for each person.");
  let chosen: unknown;
  try {
    chosen = JSON.parse(raw ?? "");
  } catch {
    throw invalid;
  }
  if (!Array.isArray(chosen) || chosen.some((id) => id !== null && !Number.isSafeInteger(id))) throw invalid;
  const rows = await contacts.query<{ id: number; name: string; hidden: number }>(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(chosen.filter((id) => id !== null)),
  );
  const found = new Map(rows.map((row) => [row.id, contactRow(row)]));
  return chosen.map((id: number | null) => {
    if (id === null) return null;
    const contact = found.get(id);
    if (!contact) throw new Error("A chosen contact is no longer in your contacts. Choose the file again.");
    return contact;
  });
}

/**
 * What a plan adds, in order, with each note's content and how it matched
 * contacts by name, hidden ones included, for Import to check that none of it
 * has changed since the preview.
 */
const planId = (plan: MemoryImportPlan, matches: Map<ClaudeMemoryNote, PersonMatch>) =>
  new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(plan.add.map((note) => [
      note.project, note.name, note.kind, note.title, note.summary, note.details, note.updatedAt,
      note.contactId, matches.get(note as ClaudeMemoryNote)?.contact?.hidden ?? null, matches.get(note as ClaudeMemoryNote)?.match ?? null,
    ])))
    .digest("hex")
    .slice(0, 16);

const isPerson = (note: ImportedMemoryNote) => note.kind === "person";

const listed = (note: ImportedMemoryNote): MemoryImportNote => ({
  project: note.project,
  name: note.name,
  kind: note.kind as MemoryKind,
  title: note.title,
});

function importResult(
  plan: MemoryImportPlan,
  id: string,
  upload: { projects: Record<string, string>; problems: MemoryImportResult["problems"] },
  matches: Map<ClaudeMemoryNote, PersonMatch>,
  /** After an import, the contact saved with each person note, in the order of `people`. */
  saved: (Contact | null)[] | null,
): MemoryImportResult {
  return {
    imported: saved !== null,
    planId: id,
    projects: upload.projects,
    add: plan.add.map(listed),
    people: plan.add.filter(isPerson).map((note, index) => {
      const matched = matches.get(note as ClaudeMemoryNote);
      if (!matched) throw new Error(`Person note ${note.path} was not matched to contacts`);
      const person = { ...listed(note), aliases: matched.aliases, match: matched.match, contact: matched.contact };
      return saved ? { ...person, saved: saved[index] } : person;
    }),
    existing: plan.existing.map(listed),
    problems: [...upload.problems, ...plan.problems],
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

    // An upload of claude.ai's claude-memory-<date>.zip or memories-000.zip (or its JSON): a preview, or with ?plan=<planId> from that preview
    // and ?links=<MemoryImportLinks> giving the contact chosen for each person it listed, the import.
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
          const upload = mapClaudeMemory(await readClaudeMemoryUpload(new Uint8Array(await c.req.arrayBuffer())));
          const matches = await matchContacts(contacts, upload.notes);
          if (expected === undefined) {
            const plan = planMemoryImport(db(), upload.notes);
            return c.json(importResult(plan, planId(plan, matches), upload, matches, null));
          }
          const links = await chosenLinks(contacts, c.req.query("links"));
          const plan = importMemoryNotes(db(), upload.notes, (fresh) => {
            // The same plan id means the same notes in the same order, so the choices line up with the people the preview listed.
            if (planId(fresh, matches) !== expected) throw new Error("Memory or your contacts have changed since the preview. Choose the file again to see what the import would add now.");
            const people = fresh.add.filter(isPerson);
            if (people.length !== links.length) throw new Error("The contact choices do not match the people in the preview. Choose the file again.");
            people.forEach((note, index) => {
              note.contactId = links[index]?.id ?? null;
            });
          });
          return c.json(importResult(plan, expected, upload, matches, links));
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
