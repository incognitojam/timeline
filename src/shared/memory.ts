/** Shared agent memory: the note shape and the web page's API responses. Stored by src/db/memory-notes.ts. */

export const MEMORY_KINDS = ["you", "project", "person", "area", "topic"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

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

/** A kept previous version: the note as it was until `replaced_at`, when it was updated or deleted. */
export interface MemoryVersion extends MemoryNote {
  replaced_at: string;
}

export interface MemoryProject {
  key: string;
  /** Whether list_memory with this project also lists the account's notes. */
  useAccountMemory: boolean;
  notes: MemoryNote[];
}

export interface MemoryIndex {
  account: MemoryNote[];
  projects: MemoryProject[];
  /** The last version of each note that is now deleted, most recently deleted first. */
  deleted: MemoryVersion[];
}

/** The index as the web page gets it: with the contact each linked live note names, by id; a contact since deleted is missing. */
export interface MemoryIndexWithContacts extends MemoryIndex {
  contacts: Record<number, MemoryImportContact>;
}

/** A note an import from claude.ai's memory export adds, or found already in memory. */
export interface MemoryImportNote {
  /** "" for the account scope. */
  project: string;
  name: string;
  kind: MemoryKind;
  title: string;
}

/**
 * How a person note was matched to a contact by name, ignoring case: by its
 * title, by one of its aliases, or not, because no contact has any of those
 * names or more than one does (`hidden` of them hidden).
 */
export type MemoryContactMatch =
  | { by: "title" }
  | { by: "alias"; alias: string }
  | { by: "none" }
  | { by: "several"; count: number; hidden: number };

/** A person note the import adds, and the contact it links to. */
export interface MemoryImportPerson extends MemoryImportNote {
  /** Other names the export gives the person that were matched like the title. */
  aliases: string[];
  match: MemoryContactMatch;
  /** The contact matched by name. */
  contact: MemoryImportContact | null;
  /** After an import, the contact the note was saved with, as it was then. */
  saved?: MemoryImportContact | null;
}

export interface MemoryImportContact {
  id: number;
  name: string;
  hidden: boolean;
}

/** The contact chosen for each person note, or null for none, in the order of the preview's `people`. */
export type MemoryImportLinks = (number | null)[];

/** What an import from claude.ai's memory export adds, or would add on a preview. */
export interface MemoryImportResult {
  imported: boolean;
  /** Identifies what a preview would add; Import with it refuses if memory or contacts have changed since. */
  planId: string;
  /** The title of each project the export names, by project key. */
  projects: Record<string, string>;
  /** Notes added, or to add. */
  add: MemoryImportNote[];
  /** The person notes among `add`, each with its contact. */
  people: MemoryImportPerson[];
  /** Notes left out because one of that name already exists in that scope. */
  existing: MemoryImportNote[];
  /** Files that cannot be imported, with the reason. */
  problems: { path: string; reason: string }[];
  /** Why the notes to add would pass the store's note limit; Import then refuses. */
  overLimit: string | null;
}
