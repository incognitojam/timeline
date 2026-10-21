/**
 * Single source of truth for the DB tables that hold content-addressed media
 * (a `content_hash` plus a local `storage_path`).
 *
 * Cross-cutting media behaviors — inventory/audit, the existing-cache upload,
 * and eviction — iterate this list so none of them can independently forget a
 * table. (The read-through restore originally forgot Discord emoji precisely
 * because the set of media tables was implicit.)
 */
export interface MediaTable {
  /** Table name. */
  table: string;
  /** Column holding the SHA-256 content hash (the remote object's identity). */
  hashCol: string;
  /** Column holding the local storage path, relative to the media root. */
  pathCol: string;
  /** Column holding the byte size. */
  sizeCol: string;
}

export const MEDIA_TABLES: readonly MediaTable[] = [
  { table: "attachments", hashCol: "content_hash", pathCol: "storage_path", sizeCol: "file_size" },
  { table: "discord_emojis", hashCol: "content_hash", pathCol: "storage_path", sizeCol: "file_size" },
] as const;
