import type { MemoryIndex, MemoryKind, MemoryNote } from "@shared/memory";
import { buildMemoryNoteUrl } from "./routes";

/** Account notes on the index, in page order. Account notes can't be of kind "project". */
export const ACCOUNT_GROUPS: ReadonlyArray<{ kind: MemoryKind; label: string }> = [
  { kind: "you", label: "You" },
  { kind: "topic", label: "Topics" },
  { kind: "area", label: "Areas" },
  { kind: "person", label: "People" },
];

export const KIND_LABELS: Record<MemoryKind, string> = {
  you: "You",
  topic: "Topic",
  area: "Area",
  person: "Person",
  project: "Project",
};

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
