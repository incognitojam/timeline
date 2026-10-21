import { Database, type SQLQueryBindings } from "bun:sqlite";
import { storeFile, type StoreFileResult } from "./storage";

type Statement = ReturnType<Database["prepare"]>;

export interface AttachmentInput {
  eventId: number;
  source: string;
  sourceId: string;
  filename?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  width?: number | null;
  height?: number | null;
  originalUri?: string | null;
}

export interface AttachmentDimensions {
  width?: number | null;
  height?: number | null;
}

interface AttachmentStatements {
  insertPending: Statement;
  upsertStored: Statement;
  markStored: Statement;
  markStoredWithDimensions: Statement;
  insertFailed: Statement;
  markFailedById: Statement;
  markUnrecoverable: Statement;
}

const statementCache = new WeakMap<Database, AttachmentStatements>();

function statements(db: Database): AttachmentStatements {
  const cached = statementCache.get(db);
  if (cached) return cached;

  const prepared: AttachmentStatements = {
    insertPending: db.prepare(`
      INSERT OR IGNORE INTO attachments (
        event_id, source, source_id, filename, mime_type, file_size,
        width, height, original_uri, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `),
    upsertStored: db.prepare(`
      INSERT INTO attachments (
        event_id, source, source_id, content_hash, filename, mime_type,
        file_size, width, height, storage_path, original_uri,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored')
      ON CONFLICT(event_id, source_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        file_size = excluded.file_size,
        width = excluded.width,
        height = excluded.height,
        storage_path = excluded.storage_path,
        original_uri = excluded.original_uri,
        status = 'stored'
    `),
    markStored: db.prepare(`
      UPDATE attachments
      SET content_hash = ?, storage_path = ?, file_size = ?, status = 'stored'
      WHERE id = ?
    `),
    markStoredWithDimensions: db.prepare(`
      UPDATE attachments
      SET content_hash = ?, storage_path = ?, file_size = ?,
          width = ?, height = ?, status = 'stored'
      WHERE id = ?
    `),
    insertFailed: db.prepare(`
      INSERT INTO attachments (
        event_id, source, source_id, filename, mime_type, file_size,
        width, height, original_uri, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed')
      ON CONFLICT(event_id, source_id) DO UPDATE SET
        status = 'failed'
    `),
    markFailedById: db.prepare(`
      UPDATE attachments
      SET status = 'failed',
          content_hash = NULL,
          storage_path = NULL,
          file_size = NULL,
          width = NULL,
          height = NULL
      WHERE id = ?
    `),
    markUnrecoverable: db.prepare(`
      INSERT INTO attachments (
        event_id, source, source_id, filename, mime_type, file_size,
        width, height, original_uri, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unrecoverable')
      ON CONFLICT(event_id, source_id) DO UPDATE SET status = 'unrecoverable'
    `),
  };

  statementCache.set(db, prepared);
  return prepared;
}

function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function attachmentArgs(a: AttachmentInput): SQLQueryBindings[] {
  return [
    a.eventId,
    a.source,
    a.sourceId,
    nullable(a.filename),
    nullable(a.mimeType),
    nullable(a.fileSize),
    nullable(a.width),
    nullable(a.height),
    nullable(a.originalUri),
  ];
}

export function insertPendingAttachment(db: Database, attachment: AttachmentInput): number {
  return statements(db).insertPending.run(...attachmentArgs(attachment)).changes;
}

export function insertStoredAttachment(
  db: Database,
  attachment: AttachmentInput,
  stored: StoreFileResult,
): void {
  statements(db).upsertStored.run(
    attachment.eventId,
    attachment.source,
    attachment.sourceId,
    stored.hash,
    nullable(attachment.filename),
    nullable(attachment.mimeType),
    stored.fileSize,
    nullable(attachment.width),
    nullable(attachment.height),
    stored.storagePath,
    nullable(attachment.originalUri),
  );
}

export async function storeAndInsertAttachment(
  db: Database,
  attachment: AttachmentInput,
  content: Buffer | Uint8Array,
  relativePath: string,
): Promise<StoreFileResult> {
  const stored = await storeFile({
    source: attachment.source,
    relativePath,
    content,
  });
  insertStoredAttachment(db, attachment, stored);
  return stored;
}

export function markAttachmentStored(
  db: Database,
  attachmentId: number,
  stored: Pick<StoreFileResult, "hash" | "storagePath" | "fileSize">,
  dimensions?: AttachmentDimensions,
): void {
  if (dimensions) {
    statements(db).markStoredWithDimensions.run(
      stored.hash,
      stored.storagePath,
      stored.fileSize,
      nullable(dimensions.width),
      nullable(dimensions.height),
      attachmentId,
    );
    return;
  }

  statements(db).markStored.run(
    stored.hash,
    stored.storagePath,
    stored.fileSize,
    attachmentId,
  );
}

export function markAttachmentFailed(db: Database, attachment: AttachmentInput): void {
  statements(db).insertFailed.run(...attachmentArgs(attachment));
}

export function markAttachmentFailedById(db: Database, attachmentId: number): void {
  statements(db).markFailedById.run(attachmentId);
}

/**
 * Mark an attachment permanently unavailable. Creates the row when a source
 * event was indexed but its attachment download never began.
 */
export function markAttachmentUnrecoverable(db: Database, attachment: AttachmentInput): void {
  statements(db).markUnrecoverable.run(...attachmentArgs(attachment));
}
