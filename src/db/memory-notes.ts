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
  details: 16000,
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

/** Live notes linked to a contact, in every scope. */
export function listContactMemoryNotes(db: Database, contactId: number): MemoryNote[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM memory_notes WHERE replaced_at IS NULL AND contact_id = ? ORDER BY project, name`)
    .all(contactId) as MemoryNote[];
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

/** Check the input as saveMemoryNote would for a note that does not exist yet, without saving. */
export function checkNewMemoryNote(db: Database, input: SaveMemoryNoteInput): void {
  checkName(input.name);
  checkFields(input, null);
  checkRoomForNote(db);
}

function checkRoomForNote(db: Database): void {
  const { count } = db
    .prepare("SELECT COUNT(*) AS count FROM memory_notes WHERE replaced_at IS NULL")
    .get() as { count: number };
  if (count >= MEMORY_LIMITS.notes) {
    throw new Error(`Memory already holds ${MEMORY_LIMITS.notes} notes, the limit. Merge or delete notes before adding another.`);
  }
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

    checkRoomForNote(db);
    const note = db.prepare(`
      INSERT INTO memory_notes (project, name, kind, title, summary, details, contact_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}
    `).get(input.project, input.name, kind, title, summary, details, contactId, now, now) as MemoryNote;
    return { note, created: true };
  }).immediate();
}

export interface ImportedMemoryNote {
  /** Where the note came from in the export, to name it in the result. */
  path: string;
  project: string;
  name: string;
  kind: string;
  title: string;
  summary: string;
  details: string;
  contactId: number | null;
  updatedAt: string;
}

export interface MemoryImportPlan {
  add: ImportedMemoryNote[];
  /** Left out: a note of that name already exists in that scope. */
  existing: ImportedMemoryNote[];
  problems: { path: string; reason: string }[];
  /** Why adding would break the note limit, or null when it fits. */
  overLimit: string | null;
}

/**
 * What importing these notes would do: add the ones whose name is new in their
 * scope, never touching an existing note. A note the store would refuse, or one
 * sharing its scope and name with another in the same import, is a problem.
 */
export function planMemoryImport(db: Database, notes: ImportedMemoryNote[]): MemoryImportPlan {
  const plan: MemoryImportPlan = { add: [], existing: [], problems: [], overLimit: null };
  const key = (note: ImportedMemoryNote) => `${note.project}/${note.name}`;
  const seen = new Map<string, number>();
  for (const note of notes) seen.set(key(note), (seen.get(key(note)) ?? 0) + 1);
  for (const note of notes) {
    try {
      checkName(note.name);
      checkFields(note, null);
    } catch (error) {
      plan.problems.push({ path: note.path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if ((seen.get(key(note)) ?? 0) > 1) {
      plan.problems.push({ path: note.path, reason: `Another file in this export is also named "${note.name}" in the same scope.` });
    } else if (getMemoryNote(db, note.project, note.name)) {
      plan.existing.push(note);
    } else {
      plan.add.push(note);
    }
  }
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM memory_notes WHERE replaced_at IS NULL").get() as { count: number };
  if (count + plan.add.length > MEMORY_LIMITS.notes) {
    plan.overLimit = `Memory holds ${count} notes; adding ${plan.add.length} would pass the limit of ${MEMORY_LIMITS.notes}. Delete notes first.`;
  }
  return plan;
}

/**
 * Add the notes planMemoryImport would add, all or none, in one transaction.
 * `confirm` sees the plan first and throws to refuse it.
 */
export function importMemoryNotes(db: Database, notes: ImportedMemoryNote[], confirm: (plan: MemoryImportPlan) => void): MemoryImportPlan {
  return db.transaction(() => {
    const plan = planMemoryImport(db, notes);
    if (plan.overLimit) throw new Error(plan.overLimit);
    confirm(plan);
    const insert = db.prepare(`
      INSERT INTO memory_notes (project, name, kind, title, summary, details, contact_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const note of plan.add) {
      // A time in the future would sort the note first wherever the newest come first.
      const at = new Date(Math.min(Date.parse(note.updatedAt), now)).toISOString();
      insert.run(note.project, note.name, note.kind, note.title, note.summary, note.details, note.contactId, at, at);
    }
    return plan;
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

/**
 * For a contact being deleted: delete its live linked notes when asked (kept as
 * previous versions, so they can be restored), then clear the link on every
 * row, versions included, so nothing points at the contact and a restored note
 * comes back unlinked. Returns how many live notes were linked.
 */
export function releaseContactMemoryNotes(db: Database, contactId: number, deleteNotes: boolean): number {
  return db.transaction(() => {
    const notes = listContactMemoryNotes(db, contactId);
    if (deleteNotes) {
      for (const note of notes) deleteMemoryNote(db, note.project, note.name);
    }
    db.prepare("UPDATE memory_notes SET contact_id = NULL WHERE contact_id = ?").run(contactId);
    return notes.length;
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
 * replaces is kept as a version, and a deleted note comes back. A live note
 * keeps its contact, so restoring text never changes whether agents can read
 * it; a deleted note comes back with the contact it had. Null when no version
 * has this id.
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
      contactId: getMemoryNote(db, version.project, version.name) ? undefined : version.contact_id,
    });
  }).immediate();
}

/**
 * Update an existing note's fields; null, creating nothing, when there is no
 * live note of that name. Only a note about a person can be linked to a
 * contact, or changed to another kind while linked. `check` sees the current
 * note first and throws to refuse the update.
 */
export function updateMemoryNote(db: Database, input: SaveMemoryNoteInput, check?: (current: MemoryNote) => void): MemoryNote | null {
  return db.transaction(() => {
    const current = getMemoryNote(db, input.project, input.name);
    if (!current) return null;
    check?.(current);
    const kind = input.kind ?? current.kind;
    const contactId = input.contactId === undefined ? current.contact_id : input.contactId;
    if (kind !== "person" && contactId !== null && (input.contactId != null || kind !== current.kind)) {
      throw new Error("Only a note about a person can be linked to a contact.");
    }
    return saveMemoryNote(db, input).note;
  }).immediate();
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
