/**
 * Discord Attachment Downloader
 *
 * Downloads Discord CDN files during sync while URLs are fresh
 * (CDN signatures are time-limited). Stores via content-addressed
 * storage with deduplication.
 */

import { Database } from "bun:sqlite";
import { extname, basename } from "path";
import { markAttachmentFailed, storeAndInsertAttachment } from "../../media/attachments";
import { getMimeType } from "../../media/storage";
import type { NormalizedMessage } from "./client";

/**
 * Sanitize an attachment filename for on-disk storage. Strips directory
 * components (Discord's `filename` field is attacker-controlled and is not
 * guaranteed to be a basename) and truncates to the 255-byte filesystem limit.
 */
export function safeFileName(name: string): string {
  const MAX_BYTES = 255;
  // basename collapses "../../foo" / "/etc/passwd" to "foo" / "passwd".
  // Leading dots are stripped so "." or ".." don't survive as a parent-dir
  // reference and ".bashrc"-style hidden names can't be planted.
  let n = basename(name).replace(/^\.+/, "");
  if (!n) n = "unnamed";
  if (Buffer.byteLength(n) <= MAX_BYTES) return n;
  const ext = extname(n);
  const base = basename(n, ext);
  const maxBaseBytes = MAX_BYTES - Buffer.byteLength(ext);
  let truncated = base;
  while (Buffer.byteLength(truncated) > maxBaseBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + ext;
}

const MAX_CONCURRENT_DOWNLOADS = 2;

interface AttachmentInfo {
  id: string;
  url: string;
  fileName: string;
  fileSizeBytes: number;
  contentType?: string;
  width?: number;
  height?: number;
}

/**
 * Download and store attachments for a Discord message event.
 * Inserts records into the attachments table.
 */
export async function downloadAndStoreAttachments(
  db: Database,
  eventId: number,
  channelId: string,
  attachments: AttachmentInfo[],
  signal?: AbortSignal
): Promise<{ stored: number; failed: number }> {
  if (attachments.length === 0) return { stored: 0, failed: 0 };

  let stored = 0;
  let failed = 0;

  // Process in batches of MAX_CONCURRENT_DOWNLOADS
  for (let i = 0; i < attachments.length; i += MAX_CONCURRENT_DOWNLOADS) {
    if (signal?.aborted) break;

    const batch = attachments.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
    const results = await Promise.allSettled(
      batch.map((att) => downloadSingleAttachment(db, eventId, channelId, att, signal))
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        stored++;
      } else {
        failed++;
        if (result.status === "rejected") {
          console.error(`[discord] Attachment download failed:`, result.reason);
        }
      }
    }
  }

  return { stored, failed };
}

async function downloadSingleAttachment(
  db: Database,
  eventId: number,
  channelId: string,
  attachment: AttachmentInfo,
  signal?: AbortSignal
): Promise<boolean> {
  const { id, url, fileName, fileSizeBytes, contentType, width, height } = attachment;

  // Check if already stored
  const existing = db
    .prepare("SELECT id, status FROM attachments WHERE event_id = ? AND source_id = ?")
    .get(eventId, id) as { id: number; status: string } | null;

  if (existing?.status === "stored") return true;

  try {
    // Download the file
    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} downloading ${fileName}`);
    }

    const content = Buffer.from(await res.arrayBuffer());

    // Store via content-addressed storage (truncate long filenames for filesystem)
    const safeName = safeFileName(fileName);
    // Determine MIME type
    const mimeType = contentType || getMimeType(fileName);

    await storeAndInsertAttachment(db, {
      eventId,
      source: "discord",
      sourceId: id,
      filename: fileName,
      mimeType,
      width: width ?? null,
      height: height ?? null,
      originalUri: url,
    }, content, `${channelId}/${id}/${safeName}`);

    return true;
  } catch (err) {
    // Don't log abort errors
    if (err instanceof DOMException && err.name === "AbortError") throw err;

    console.error(`[discord] Failed to download attachment ${fileName}:`, err);

    markAttachmentFailed(db, {
      eventId,
      source: "discord",
      sourceId: id,
      filename: fileName,
      mimeType: contentType || getMimeType(fileName),
      fileSize: fileSizeBytes,
      width: width ?? null,
      height: height ?? null,
      originalUri: url,
    });

    return false;
  }
}
