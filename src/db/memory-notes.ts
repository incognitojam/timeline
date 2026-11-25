/**
 * Shared agent memory: notes any MCP client can read and write, stored in
 * app-state.db (table in app-state.ts). A note belongs to the account
 * (project "") or to one project, and its name is unique within that scope.
 */

import { MEMORY_KINDS, type MemoryIndex, type MemoryNote, type MemoryVersion } from "../shared/memory";
import type { Database } from "./sqlite";

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

/** Every live note and, per project, whether it uses the account's notes, plus the notes now deleted. */
export function memoryIndex(db: Database): MemoryIndex {
  const live = db
    .prepare(`SELECT ${COLUMNS} FROM memory_notes WHERE replaced_at IS NULL ORDER BY project, name`)
    .all() as MemoryNote[];
  const projects = new Map<string, MemoryNote[]>();
  for (const note of live) {
    if (!note.project) continue;
    let notes = projects.get(note.project);
    if (!notes) {
      notes = [];
      projects.set(note.project, notes);
    }
    notes.push(note);
  }
  const deleted = db.prepare(`
    SELECT ${COLUMNS}, replaced_at FROM memory_notes old
    WHERE replaced_at IS NOT NULL
      AND id = (SELECT MAX(id) FROM memory_notes v WHERE v.project = old.project AND v.name = old.name)
      AND NOT EXISTS (
        SELECT 1 FROM memory_notes live
        WHERE live.replaced_at IS NULL AND live.project = old.project AND live.name = old.name
      )
    ORDER BY id DESC
  `).all() as MemoryVersion[];
  // A project with account memory off stays listed after its last note goes, so it can be switched back on.
  const off = projectsWithoutAccountMemory(db);
  for (const key of off) if (!projects.has(key)) projects.set(key, []);
  return {
    account: live.filter((note) => !note.project),
    projects: [...projects]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, notes]) => ({ key, useAccountMemory: !off.includes(key), notes })),
    deleted,
  };
}

/** A note's kept previous versions, newest first. */
export function listMemoryVersions(db: Database, project: string, name: string): MemoryVersion[] {
  return db
    .prepare(`SELECT ${COLUMNS}, replaced_at FROM memory_notes WHERE replaced_at IS NOT NULL AND project = ? AND name = ? ORDER BY id DESC`)
    .all(project, name) as MemoryVersion[];
}

/**
 * Make a kept version the live note again, through saveMemoryNote: the note it
 * replaces is kept as a version, and a deleted note comes back. Null when no
 * version has this id.
 */
export function restoreMemoryVersion(db: Database, id: number): { note: MemoryNote; created: boolean } | null {
  return db.transaction(() => {
    const version = db
      .prepare(`SELECT ${COLUMNS} FROM memory_notes WHERE id = ? AND replaced_at IS NOT NULL`)
      .get(id) as MemoryNote | null;
    if (!version) return null;
    return saveMemoryNote(db, {
      project: version.project,
      name: version.name,
      kind: version.kind,
      title: version.title,
      summary: version.summary,
      details: version.details,
      contactId: version.contact_id,
    });
  }).immediate();
}

/** Update an existing note's fields; null, creating nothing, when there is no live note of that name. */
export function updateMemoryNote(db: Database, input: SaveMemoryNoteInput): MemoryNote | null {
  return db.transaction(() => (getMemoryNote(db, input.project, input.name) ? saveMemoryNote(db, input).note : null)).immediate();
}

// Projects whose list_memory leaves out the account's notes, as a JSON array in app_settings.
const NO_ACCOUNT_MEMORY_KEY = "memory.projects_without_account";

function projectsWithoutAccountMemory(db: Database): string[] {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(NO_ACCOUNT_MEMORY_KEY) as { value: string } | null;
  return row ? (JSON.parse(row.value) as string[]) : [];
}

/** Whether list_memory with this project also lists the account's notes: yes unless the user switched it off. */
export function projectUsesAccountMemory(db: Database, project: string): boolean {
  return !project || !projectsWithoutAccountMemory(db).includes(project);
}

export function setProjectUsesAccountMemory(db: Database, project: string, use: boolean): void {
  if (!project || projectScope(project) !== project) throw new Error(`"${project}" is not a project key.`);
  db.transaction(() => {
    const off = projectsWithoutAccountMemory(db).filter((key) => key !== project);
    if (!use) off.push(project);
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(NO_ACCOUNT_MEMORY_KEY, JSON.stringify(off));
  }).immediate();
}
