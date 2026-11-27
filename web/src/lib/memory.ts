import type { MemoryIndex, MemoryKind, MemoryNote } from "@shared/memory";
import { buildMemoryNoteUrl } from "./routes";

/**
 * How each kind of note is named: `label` for one note's kind, `heading` for a
 * group of them, `one`/`many` in a count, and `hint` where the name alone
 * does not say what the notes are.
 */
export const KINDS: Record<MemoryKind, { label: string; heading: string; one: string; many: string; hint?: string }> = {
  you: { label: "You", heading: "You", one: "note about you", many: "notes about you" },
  project: { label: "Project", heading: "Project", one: "note about the project", many: "notes about the project" },
  topic: { label: "Topic", heading: "Topics", one: "topic", many: "topics", hint: "subjects that come up in conversations" },
  area: { label: "Area", heading: "Areas", one: "area of your life", many: "areas of your life", hint: "ongoing parts of life, such as home or work" },
  person: { label: "Person", heading: "People", one: "person", many: "people" },
};

/** Kinds in page order. */
export const KIND_ORDER: readonly MemoryKind[] = ["you", "project", "topic", "area", "person"];

export const countKind = (kind: MemoryKind, count: number) => `${count} ${count === 1 ? KINDS[kind].one : KINDS[kind].many}`;

/** Account notes on the index, in page order. Account notes can't be of kind "project". */
export const ACCOUNT_GROUPS = KIND_ORDER.filter((kind) => kind !== "project").map((kind) => ({ kind, label: KINDS[kind].heading }));

export function scopeLabel(project: string): string {
  return project ? `Project ${project}` : "Account";
}

/** A project's notes with its overview first. */
export function projectNotesInOrder(notes: readonly MemoryNote[]): MemoryNote[] {
  return [...notes].sort((a, b) => Number(b.name === "overview") - Number(a.name === "overview"));
}

/** Backslash-escape Markdown punctuation so a title shows as typed inside link text. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~&]/g, "\\$&");
}

/**
 * Details with each `[[name]]` turned into a Markdown link to the note of that
 * name in the note's project, else in the account. A link to a missing note
 * becomes its name as plain text.
 */
export function linkMemoryNotes(details: string, project: string, index: MemoryIndex): string {
  const projectNotes = index.projects.find((p) => p.key === project)?.notes ?? [];
  return details.replace(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g, (_, name: string) => {
    const target = (project ? projectNotes.find((note) => note.name === name) : undefined)
      ?? index.account.find((note) => note.name === name);
    if (!target) return name;
    return `[${escapeMarkdown(target.title)}](${buildMemoryNoteUrl(target.project, target.name)})`;
  });
}

export function formatMemoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
