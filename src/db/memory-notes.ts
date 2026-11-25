/**
 * Shared agent memory: notes any MCP client can read and write, stored in
 * app-state.db (table in app-state.ts). A note belongs to the account
 * (project "") or to one project, and its name is unique within that scope.
 */

import type { Database } from "./sqlite";

export const MEMORY_KINDS = ["you", "project", "person", "area", "topic"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_LIMITS = {
  name: 64,
  title: 120,
  summary: 240,
  details: 8000,
  /** Live notes across every scope. */
  notes: 500,
  /** Previous versions kept per note for restoring, newest first. */
  versionsPerNote: 10,
  /** Previous versions kept across every note; the oldest beyond this are dropped. */
  versions: 2000,
} as const;

export interface MemoryNote {
  id: number;
  /** "" for the account scope. */
  project: string;
  name: string;
  kind: MemoryKind;
  title: string;
  summary: string;
  details: string;
  contact_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface SaveMemoryNoteInput {
  project: string;
  name: string;
  kind?: string;
  title?: string;
  summary?: string;
  details?: string;
  /** null unlinks the contact; undefined keeps it. */
  contactId?: number | null;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLUMNS = "id, project, name, kind, title, summary, details, contact_id, created_at, updated_at";

/** The scope a tool's project argument names: "" (the account) when omitted, else the key normalised to a slug. */
export function projectScope(raw: string | undefined): string {
  if (raw === undefined) return "";
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!key) throw new Error(`Project "${raw}" has no letters or digits to make a key from.`);
  if (key.length > MEMORY_LIMITS.name) throw new Error(`Project key is longer than ${MEMORY_LIMITS.name} characters.`);
  return key;
}

function checkName(name: string): void {
  if (name.length > MEMORY_LIMITS.name || !SLUG.test(name)) {
    throw new Error(`Note name must be a lowercase slug of letters, digits and single hyphens, at most ${MEMORY_LIMITS.name} characters (e.g. "coffee-order").`);
  }
}

function checkText(field: "title" | "summary" | "details", value: string): void {
  if (field !== "details" && !value.trim()) throw new Error(`Note ${field} must not be empty.`);
  // Title and summary are index lines: no line breaks or other control characters.
  if (field !== "details" && /[\p{Cc}\u2028\u2029]/u.test(value)) throw new Error(`Note ${field} must be one line of plain text.`);
  const limit = MEMORY_LIMITS[field];
  if (value.length > limit) throw new Error(`Note ${field} is ${value.length} characters; the limit is ${limit}.`);
}

/** Live notes in the account scope, plus those of `project` when given. */
export function listMemoryNotes(db: Database, project = ""): MemoryNote[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM memory_notes WHERE replaced_at IS NULL AND project IN ('', ?) ORDER BY name`)
    .all(project) as MemoryNote[];
}

export function getMemoryNote(db: Database, project: string, name: string): MemoryNote | null {
  return db
    .prepare(`SELECT ${COLUMNS} FROM memory_notes WHERE replaced_at IS NULL AND project = ? AND name = ?`)
    .get(project, name) as MemoryNote | null;
}

/** Keep a copy of the live row as a previous version, then drop the oldest versions past the limits. */
function keepPreviousVersion(db: Database, id: number, now: string): void {
  db.prepare(`
    INSERT INTO memory_notes (project, name, kind, title, summary, details, contact_id, created_at, updated_at, replaced_at)
    SELECT project, name, kind, title, summary, details, contact_id, created_at, updated_at, ?
    FROM memory_notes WHERE id = ?
  `).run(now, id);
  db.prepare(`
    DELETE FROM memory_notes WHERE replaced_at IS NOT NULL AND id IN (
      SELECT old.id FROM memory_notes old JOIN memory_notes live ON live.id = ?
      WHERE old.replaced_at IS NOT NULL AND old.project = live.project AND old.name = live.name
      ORDER BY old.id DESC LIMIT -1 OFFSET ?
    )
  `).run(id, MEMORY_LIMITS.versionsPerNote);
  db.prepare(`
    DELETE FROM memory_notes WHERE replaced_at IS NOT NULL AND id NOT IN (
      SELECT id FROM memory_notes WHERE replaced_at IS NOT NULL ORDER BY id DESC LIMIT ?
    )
  `).run(MEMORY_LIMITS.versions);
}

/** The note's fields after applying the input to the current note, checked. */
function checkFields(input: SaveMemoryNoteInput, current: MemoryNote | null) {
  const kind = input.kind ?? current?.kind;
  const title = input.title ?? current?.title;
  const summary = input.summary ?? current?.summary;
  const details = input.details ?? current?.details ?? "";
  if (kind === undefined || title === undefined || summary === undefined) {
    throw new Error("A new note needs a kind, a title and a summary.");
  }
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Note kind must be one of: ${MEMORY_KINDS.join(", ")}.`);
  }
  if (kind === "project" && !input.project) {
    throw new Error('A note of kind "project" must belong to a project; pass project.');
  }
  checkText("title", title);
  checkText("summary", summary);
  checkText("details", details);
  return { kind, title, summary, details };
}

/**
 * Create a note, or update the one with this name in this scope, replacing
 * only the fields given.
 */
export function saveMemoryNote(db: Database, input: SaveMemoryNoteInput): { note: MemoryNote; created: boolean } {
  checkName(input.name);
  return db.transaction(() => {
    const current = getMemoryNote(db, input.project, input.name);
    const { kind, title, summary, details } = checkFields(input, current);
    const contactId = input.contactId === undefined ? (current?.contact_id ?? null) : input.contactId;

    if (current && kind === current.kind && title === current.title && summary === current.summary
      && details === current.details && contactId === current.contact_id) {
      return { note: current, created: false };
    }

    const now = new Date().toISOString();
    if (current) {
      keepPreviousVersion(db, current.id, now);
      const note = db.prepare(`
        UPDATE memory_notes SET kind = ?, title = ?, summary = ?, details = ?, contact_id = ?, updated_at = ?
        WHERE id = ? RETURNING ${COLUMNS}
      `).get(kind, title, summary, details, contactId, now, current.id) as MemoryNote;
      return { note, created: false };
    }

    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM memory_notes WHERE replaced_at IS NULL")
      .get() as { count: number };
    if (count >= MEMORY_LIMITS.notes) {
      throw new Error(`Memory already holds ${MEMORY_LIMITS.notes} notes, the limit. Merge or delete notes before adding another.`);
    }
    const note = db.prepare(`
      INSERT INTO memory_notes (project, name, kind, title, summary, details, contact_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}
    `).get(input.project, input.name, kind, title, summary, details, contactId, now, now) as MemoryNote;
    return { note, created: true };
  }).immediate();
}

/** Delete a note, keeping it as a previous version. Returns the deleted note, or null if there was none. */
export function deleteMemoryNote(db: Database, project: string, name: string): MemoryNote | null {
  return db.transaction(() => {
    const current = getMemoryNote(db, project, name);
    if (!current) return null;
    keepPreviousVersion(db, current.id, new Date().toISOString());
    db.prepare("DELETE FROM memory_notes WHERE id = ?").run(current.id);
    return current;
  }).immediate();
}
