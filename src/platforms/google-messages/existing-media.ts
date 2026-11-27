import type { Database } from "bun:sqlite";
import { getMediaStore } from "../../media/storage";

/** Identifies which copy was stored even after a retry or a thumbnail upgrade. */
export function mediaCopyUri(mediaId: string, copy: "stored" | "thumbnail"): string {
  return `google-messages:${copy}/${encodeURIComponent(mediaId)}`;
}

interface ExistingMedia {
  path: string;
  size: number;
  sha256: string;
}

/** The sidecar validates candidate files lazily, only for messages it revisits. */
export async function existingMediaManifest(db: Database, account: string, conversationId?: string): Promise<Record<string, Record<string, ExistingMedia>>> {
  const store = await getMediaStore();
  const manifest: Record<string, Record<string, ExistingMedia>> = Object.create(null);
  const rows = db.query<{
    message_id: string; media_id: string; storage_path: string; file_size: number; content_hash: string; original_uri: string | null;
  }, string[]>(`
    SELECT e.source_id AS message_id, a.source_id AS media_id, a.storage_path,
           a.file_size, a.content_hash, a.original_uri
    FROM attachments a JOIN events e ON e.id = a.event_id
    WHERE e.source = 'google-messages' AND a.source = 'google-messages' AND e.source_account = ?
      ${conversationId === undefined ? "" : "AND e.conversation_id = ?"}
      AND a.status = 'stored' AND a.storage_path IS NOT NULL
      AND a.file_size > 0 AND a.content_hash IS NOT NULL
      AND (a.original_uri IS NOT NULL OR EXISTS (
        SELECT 1 FROM json_each(e.raw_data, '$.media') m
        WHERE json_extract(m.value, '$.media_id') = a.source_id
          AND json_extract(m.value, '$.status') = 'stored'
          AND json_extract(m.value, '$.size') = a.file_size
      ))
  `).all(account, ...(conversationId === undefined ? [] : [conversationId]));
  for (const row of rows) {
    if (row.original_uri !== null && row.original_uri !== mediaCopyUri(row.media_id, "stored")) continue;
    const parts = manifest[row.message_id] ?? (manifest[row.message_id] = Object.create(null));
    parts[row.media_id] = { path: store.getAbsolutePath(row.storage_path), size: row.file_size, sha256: row.content_hash };
  }
  return manifest;
}
