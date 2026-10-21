/**
 * Recover Discord attachments whose initial sync download did not complete.
 *
 * Discord CDN URLs in event raw data are short-lived, so candidates are
 * re-fetched through the API before the normal attachment downloader runs.
 */

import type { Database } from "bun:sqlite";
import { type AttachmentInput, markAttachmentUnrecoverable } from "../../media/attachments";
import {
  getDiscordMessageAttachments,
  getDiscordStickerItems,
} from "../../shared/discord-forward";
import { downloadAndStoreAttachments } from "./attachment-downloader";
import type { DiscordClient, NormalizedMessage } from "./client";
import {
  getMessageAttachments,
  getStickerAttachment,
} from "./event-converter";

export const DISCORD_ATTACHMENT_RETRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DISCORD_ATTACHMENT_RETRY_LIMIT = 25;

interface RawAttachment {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  contentType?: string;
  width?: number;
  height?: number;
  url: string;
}

interface CandidateRow {
  event_id: number;
  message_id: string;
  channel_id: string;
  raw_data: string;
}

interface AttachmentRow {
  source_id: string | null;
  status: string;
}

interface RetryCandidate {
  eventId: number;
  messageId: string;
  channelId: string;
  targetIds: string[];
  directIds: string[];
  attachmentsById: Map<string, RawAttachment>;
}

export interface DiscordAttachmentRetryResult {
  attempted: number;
  stored: number;
  failed: number;
  unrecoverable: number;
  unavailable: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Discord sync aborted", "AbortError");
}

function parseRawAssets(rawData: string): {
  attachmentsById: Map<string, RawAttachment>;
  directIds: Set<string>;
} {
  const attachmentsById = new Map<string, RawAttachment>();
  const directIds = new Set<string>();
  for (const attachment of getDiscordMessageAttachments(rawData)) {
    attachmentsById.set(attachment.id, {
      id: attachment.id,
      fileName: attachment.filename,
      fileSizeBytes: attachment.size,
      contentType: attachment.content_type,
      width: attachment.width,
      height: attachment.height,
      url: attachment.url,
    });
  }
  for (const sticker of getDiscordStickerItems(rawData)) {
    if (sticker.id === null || sticker.name === null || sticker.formatType === null) continue;
    const attachment = getStickerAttachment({
      id: sticker.id,
      name: sticker.name,
      formatType: sticker.formatType,
    });
    if (attachment) {
      attachmentsById.set(attachment.id, attachment);
      directIds.add(attachment.id);
    }
  }
  return { attachmentsById, directIds };
}

function attachmentInput(eventId: number, id: string, attachment?: RawAttachment): AttachmentInput {
  return {
    eventId,
    source: "discord",
    sourceId: id,
    filename: attachment?.fileName,
    mimeType: attachment?.contentType,
    fileSize: attachment?.fileSizeBytes,
    width: attachment?.width,
    height: attachment?.height,
    originalUri: attachment?.url,
  };
}

function findCandidates(
  db: Database,
  sourceAccount: string,
  now: Date,
  limit: number,
): RetryCandidate[] {
  const cutoff = new Date(now.getTime() - DISCORD_ATTACHMENT_RETRY_MAX_AGE_MS).toISOString();
  const rawAssetCount = `
    COALESCE(json_array_length(json_extract(e.raw_data, '$.attachments')), 0)
    + COALESCE((
      SELECT SUM(COALESCE(
        json_array_length(json_extract(snapshot.value, '$.message.attachments')),
        0
      ))
      FROM json_each(e.raw_data, '$.message_snapshots') snapshot
    ), 0)
    + COALESCE(json_array_length(json_extract(e.raw_data, '$.sticker_items')), 0)
    + COALESCE((
      SELECT SUM(COALESCE(
        json_array_length(json_extract(snapshot.value, '$.message.sticker_items')),
        0
      ))
      FROM json_each(e.raw_data, '$.message_snapshots') snapshot
    ), 0)
  `;
  const rows = db.query(`
    SELECT e.id AS event_id, e.source_id AS message_id,
           json_extract(e.raw_data, '$._channel.id') AS channel_id, e.raw_data
    FROM events e
    WHERE e.source = 'discord'
      AND e.source_account = ?
      AND e.timestamp >= ?
      AND (${rawAssetCount}) > 0
      AND json_extract(e.raw_data, '$._channel.id') IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM attachments a
          WHERE a.event_id = e.id AND a.source = 'discord' AND a.status = 'failed'
        )
        OR NOT EXISTS (
          SELECT 1 FROM attachments a
          WHERE a.event_id = e.id AND a.source = 'discord'
        )
        OR (
          SELECT COUNT(*) FROM attachments a
          WHERE a.event_id = e.id AND a.source = 'discord'
        ) < (${rawAssetCount})
      )
    ORDER BY e.timestamp DESC, e.id DESC
    LIMIT ?
  `).all(sourceAccount, cutoff, limit) as CandidateRow[];

  const attachmentRows = db.prepare(
    "SELECT source_id, status FROM attachments WHERE event_id = ? AND source = 'discord'",
  );
  const candidates: RetryCandidate[] = [];
  for (const row of rows) {
    const { attachmentsById, directIds } = parseRawAssets(row.raw_data);
    if (attachmentsById.size === 0) continue;
    const existing = new Map<string, string>();
    for (const attachment of attachmentRows.all(row.event_id) as AttachmentRow[]) {
      if (attachment.source_id) existing.set(attachment.source_id, attachment.status);
    }
    const targetIds = [...attachmentsById.keys()].filter((id) => {
      const status = existing.get(id);
      return status === undefined || status === "failed";
    });
    if (targetIds.length === 0) continue;
    candidates.push({
      eventId: row.event_id,
      messageId: row.message_id,
      channelId: row.channel_id,
      targetIds,
      directIds: targetIds.filter((id) => directIds.has(id)),
      attachmentsById,
    });
  }
  return candidates;
}

function tombstoneMissingAttachments(
  db: Database,
  candidate: RetryCandidate,
  ids: readonly string[],
): number {
  for (const id of ids) {
    markAttachmentUnrecoverable(
      db,
      attachmentInput(candidate.eventId, id, candidate.attachmentsById.get(id)),
    );
  }
  return ids.length;
}

/**
 * Retry recent failed/missing Discord attachment downloads. A 404 or an
 * attachment absent from the freshly fetched message is permanent; a 403 or
 * transient fetch failure is left for a later sync.
 */
export async function retryDiscordAttachments(
  db: Database,
  client: DiscordClient,
  sourceAccount: string,
  signal?: AbortSignal,
  now = new Date(),
): Promise<DiscordAttachmentRetryResult> {
  const result: DiscordAttachmentRetryResult = {
    attempted: 0,
    stored: 0,
    failed: 0,
    unrecoverable: 0,
    unavailable: 0,
  };

  for (const candidate of findCandidates(db, sourceAccount, now, DISCORD_ATTACHMENT_RETRY_LIMIT)) {
    throwIfAborted(signal);
    result.attempted++;
    try {
      // Standard sticker CDN URLs are unsigned and stable, so they can be
      // retried directly instead of spending a message API request to refresh.
      const directDownloads = candidate.directIds
        .map((id) => candidate.attachmentsById.get(id))
        .filter((attachment): attachment is RawAttachment => attachment !== undefined);
      const directResult = await downloadAndStoreAttachments(
        db,
        candidate.eventId,
        candidate.channelId,
        directDownloads,
        signal,
      );
      result.stored += directResult.stored;
      result.failed += directResult.failed;

      const refreshIds = candidate.targetIds.filter((id) => !candidate.directIds.includes(id));
      if (refreshIds.length === 0) continue;

      const fetched = await client.fetchMessageForAttachmentRecovery(
        candidate.channelId,
        candidate.messageId,
      );
      if (fetched.kind === "unavailable") {
        result.unavailable++;
        continue;
      }
      if (fetched.kind === "not-found") {
        result.unrecoverable += tombstoneMissingAttachments(db, candidate, refreshIds);
        continue;
      }

      const freshAttachments = new Map(
        getMessageAttachments(fetched.message).map((attachment) => [attachment.id, attachment]),
      );
      const missingIds = refreshIds.filter((id) => !freshAttachments.has(id));
      result.unrecoverable += tombstoneMissingAttachments(db, candidate, missingIds);

      const toDownload = refreshIds
        .map((id) => freshAttachments.get(id))
        .filter((attachment): attachment is NormalizedMessage["attachments"][number] => attachment !== undefined);
      const downloadResult = await downloadAndStoreAttachments(
        db,
        candidate.eventId,
        candidate.channelId,
        toDownload,
        signal,
      );
      result.stored += downloadResult.stored;
      result.failed += downloadResult.failed;
      throwIfAborted(signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      result.failed++;
      console.error(
        `[discord] Attachment recovery fetch failed for ${candidate.messageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}
