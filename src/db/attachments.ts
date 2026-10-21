import { latestAttachmentDescriptionSelect } from "../export/attachment-descriptions";
import {
  countDescriptionEligibleHashes,
  countNeedingDescriptions,
  describableAttachmentFilters,
} from "../media/describe-attachments";
import type {
  AttachmentDescriptionEntry,
  AttachmentDetail,
  AttachmentListItem,
  AttachmentStatus,
  AttachmentsListResponse,
  AttachmentsStats,
} from "../shared/attachments";
import { createCursor, parseCursor } from "./events";
import type { QueryExecutor } from "./pool";

export type {
  AttachmentDescriptionEntry,
  AttachmentDetail,
  AttachmentListItem,
  AttachmentStatus,
  AttachmentsListResponse,
  AttachmentsStats,
};

export interface ListAttachmentsOptions {
  limit?: number;
  cursor?: string;
  mime?: "image" | "video" | "audio";
  source?: string;
  excludeSources?: readonly string[];
  described?: boolean;
  status?: AttachmentStatus;
  preferredDescriptionModels?: readonly string[];
}

interface CountRow {
  count: number;
}

function attachmentListItemSelect(
  preferredDescriptionModels?: readonly string[],
  scanOrder: "events-first" | "attachments-first" = "events-first",
): { sql: string; params: string[] } {
  const descriptionSelect = latestAttachmentDescriptionSelect("ad.rowid", preferredDescriptionModels);
  const from = scanOrder === "events-first"
    ? "FROM events e CROSS JOIN attachments a ON a.event_id = e.id"
    : "FROM attachments a CROSS JOIN events e ON e.id = a.event_id";
  return {
    params: descriptionSelect.params,
    sql: `
  SELECT
    a.id AS id,
    a.event_id AS eventId,
    a.source AS source,
    a.filename AS filename,
    a.mime_type AS mimeType,
    a.file_size AS fileSize,
    a.width AS width,
    a.height AS height,
    a.duration_ms AS durationMs,
    a.storage_path AS storagePath,
    a.thumbhash AS thumbhash,
    a.content_hash AS contentHash,
    a.status AS status,
    e.timestamp AS timestamp,
    latest_description.description AS description,
    latest_description.model AS descriptionModel
  ${from}
  LEFT JOIN attachment_descriptions latest_description
    ON latest_description.rowid = ${descriptionSelect.sql}
`,
  };
}

async function queryAttachments(
  db: QueryExecutor,
  conditions: string[],
  params: Array<string | number>,
  limit: number,
  preferredDescriptionModels?: readonly string[],
): Promise<AttachmentListItem[]> {
  const select = attachmentListItemSelect(preferredDescriptionModels);
  return db.query<AttachmentListItem>(`${select.sql}
    WHERE ${conditions.join(" AND ")}
    ORDER BY e.timestamp DESC, a.id DESC
    LIMIT ?
  `, ...select.params, ...params, limit);
}

/** Get one attachment and every generated description for its shared content hash. */
export async function getAttachmentDetail(
  db: QueryExecutor,
  id: number,
  preferredDescriptionModels?: readonly string[],
): Promise<AttachmentDetail | null> {
  // The gallery query intentionally walks events by timestamp, but a lookup by
  // attachment ID must start from the attachment primary key. Reusing the
  // events-first order here makes SQLite scan the events corpus for one row.
  const select = attachmentListItemSelect(preferredDescriptionModels, "attachments-first");
  const attachment = await db.get<AttachmentListItem>(`${select.sql}
    WHERE a.id = ?
  `, ...select.params, id);
  if (!attachment) return null;

  const descriptions = attachment.contentHash
    ? await db.query<AttachmentDescriptionEntry>(`
      SELECT
        model,
        description,
        strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS createdAt,
        duration_ms AS durationMs
      FROM attachment_descriptions
      WHERE content_hash = ?
      ORDER BY created_at DESC, model DESC
    `, attachment.contentHash)
    : [];
  return { ...attachment, descriptions };
}

/**
 * Get attachments across the entire timeline, newest event first. Event timestamps
 * are followed by attachment ID so rows with matching or null timestamps remain stable.
 */
export async function listAttachments(
  db: QueryExecutor,
  options: ListAttachmentsOptions = {},
): Promise<AttachmentsListResponse> {
  const {
    limit = 100,
    cursor,
    mime,
    source,
    excludeSources = [],
    described,
    status = "stored",
    preferredDescriptionModels,
  } = options;
  // CROSS JOIN fixes events as the outer loop so SQLite walks its timestamp index
  // and can stop after a page instead of sorting every matching attachment.
  const conditions = ["+a.status = ?"];
  const params: Array<string | number> = [status];

  if (mime) {
    conditions.push("a.mime_type LIKE ?");
    params.push(`${mime}/%`);
  }
  if (source) {
    // Attachment source is the originating event source. Including the event
    // predicate lets SQLite use idx_events_source_timestamp for this filter.
    conditions.push("e.source = ?", "a.source = ?");
    params.push(source, source);
  } else if (excludeSources.length > 0) {
    const placeholders = excludeSources.map(() => "?").join(", ");
    conditions.push(`e.source NOT IN (${placeholders})`, `a.source NOT IN (${placeholders})`);
    params.push(...excludeSources, ...excludeSources);
  }
  if (described !== undefined) {
    // Status is already pinned by the caller's status condition above; asserting
    // 'stored' here too would make any other status + described always-empty.
    conditions.push(...describableAttachmentFilters("a"));
    conditions.push(`${described ? "" : "NOT "}EXISTS (
      SELECT 1 FROM attachment_descriptions ad WHERE ad.content_hash = a.content_hash
    )`);
  }

  let parsedCursor: ReturnType<typeof parseCursor> | null = null;
  if (cursor) {
    parsedCursor = parseCursor(cursor, { allowNullTimestamp: true });
    if (!parsedCursor) throw new Error("Invalid attachments cursor");
  }

  let rows: AttachmentListItem[];
  if (parsedCursor?.timestamp === null) {
    rows = await queryAttachments(
      db,
      [...conditions, "e.timestamp IS NULL", "a.id < ?"],
      [...params, parsedCursor.id],
      limit + 1,
      preferredDescriptionModels,
    );
  } else {
    const timestampConditions = [...conditions, "e.timestamp IS NOT NULL"];
    const timestampParams = [...params];
    if (parsedCursor) {
      timestampConditions.push("e.timestamp <= ?", "(e.timestamp < ? OR a.id < ?)");
      timestampParams.push(parsedCursor.timestamp, parsedCursor.timestamp, parsedCursor.id);
    }
    rows = await queryAttachments(db, timestampConditions, timestampParams, limit + 1, preferredDescriptionModels);

    // NULL timestamps sort last. Only look at them once timestamped rows can no
    // longer fill this page, preserving index-backed pagination for normal pages.
    if (rows.length < limit + 1) {
      rows.push(...await queryAttachments(
        db,
        [...conditions, "e.timestamp IS NULL"],
        params,
        limit + 1 - rows.length,
        preferredDescriptionModels,
      ));
    }
  }

  const hasNextPage = rows.length > limit;
  const attachments = hasNextPage ? rows.slice(0, limit) : rows;
  const lastAttachment = attachments[attachments.length - 1];
  return {
    attachments,
    nextCursor: hasNextPage && lastAttachment
      ? createCursor(lastAttachment, { allowNullTimestamp: true })
      : null,
  };
}

export async function getAttachmentsStats(db: QueryExecutor): Promise<AttachmentsStats> {
  const [total, statusRows, distinctHashes, descriptionEligibleHashes, needingDescription, byModel, bySource] = await Promise.all([
    db.get<CountRow>("SELECT COUNT(*) AS count FROM attachments"),
    db.query<{ status: AttachmentStatus; count: number }>(`
      SELECT status, COUNT(*) AS count
      FROM attachments
      GROUP BY status
    `),
    db.get<CountRow>("SELECT COUNT(DISTINCT content_hash) AS count FROM attachments WHERE content_hash IS NOT NULL"),
    countDescriptionEligibleHashes(db),
    countNeedingDescriptions(db),
    db.query<{ model: string; count: number }>(`
      SELECT model, COUNT(*) AS count
      FROM attachment_descriptions
      GROUP BY model
      ORDER BY count DESC, model ASC
    `),
    db.query<{ source: string; count: number }>(`
      SELECT source, COUNT(*) AS count
      FROM attachments
      GROUP BY source
      ORDER BY count DESC, source ASC
    `),
  ]);
  if (!total || !distinctHashes) {
    throw new Error("Attachment stats COUNT query returned no result");
  }

  const byStatus: Record<AttachmentStatus, number> = {
    pending: 0,
    stored: 0,
    failed: 0,
    unrecoverable: 0,
  };
  for (const row of statusRows) {
    if (row.status in byStatus) byStatus[row.status] = row.count;
  }

  return {
    total: total.count,
    byStatus,
    distinctHashes: distinctHashes.count,
    descriptionEligibleHashes,
    describedHashes: descriptionEligibleHashes - needingDescription,
    needingDescription,
    byModel,
    bySource,
  };
}
