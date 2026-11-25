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
