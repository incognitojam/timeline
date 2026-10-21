import type { Database } from "bun:sqlite";
import { getRenderer } from "../../render";
import type { NormalizedMessage } from "./client";
import {
  buildDiscordMessageRawData,
  getDiscordMessageEventType,
} from "./event-converter";

interface StoredDiscordEvent {
  id: number;
  type: string;
  raw_data: string;
  source_deleted_observed_at: string | null;
}

export interface ReconcileMessageResult {
  found: boolean;
  edited: boolean;
  tombstoneCleared: boolean;
}

const EDIT_REPLACEMENT_FIELDS = [
  "content",
  "flags",
  "edited_timestamp",
  "attachments",
  "embeds",
  "mentions",
  "mention_roles",
  "mention_channels",
  "message_snapshots",
  "sticker_items",
  "components",
] as const;

function sourceEditedAt(rawData: Record<string, unknown>): string | null {
  return typeof rawData.edited_timestamp === "string" ? rawData.edited_timestamp : null;
}

function attachmentFingerprint(value: unknown): unknown {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") return item;
    const attachment = item as Record<string, unknown>;
    return {
      id: attachment.id,
      filename: attachment.filename,
      size: attachment.size,
      content_type: attachment.content_type,
      width: attachment.width,
      height: attachment.height,
    };
  });
}

function editFingerprint(rawData: Record<string, unknown>): string {
  return JSON.stringify({
    content: rawData.content ?? null,
    attachments: attachmentFingerprint(rawData.attachments),
    flags: rawData.flags ?? null,
  });
}

function baseMessageType(type: string): "message:dm" | "message:group" | "message:guild" {
  if (type === "message:dm" || type.startsWith("message:dm:")) return "message:dm";
  if (type === "message:group" || type.startsWith("message:group:")) return "message:group";
  if (type === "message:guild" || type.startsWith("message:guild:")) return "message:guild";
  throw new Error(`Unexpected Discord message event type: ${type}`);
}

function mergeEditedFields(
  stored: Record<string, unknown>,
  fresh: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...stored };
  for (const field of EDIT_REPLACEMENT_FIELDS) {
    if (fresh[field] === undefined) delete next[field];
    else next[field] = fresh[field];
  }
  return next;
}

/**
 * Reconcile a message that Timeline has fetched again. Only source-owned edit
 * fields are replaced; locally enriched reactions, poll voters, call details,
 * reply previews, and channel context remain intact.
 */
export function reconcileDiscordMessage(
  db: Database,
  message: NormalizedMessage,
  sourceAccount: string,
  observedAt = new Date().toISOString(),
): ReconcileMessageResult {
  const stored = db.prepare(
    `SELECT id, type, raw_data, source_deleted_observed_at
     FROM events
     WHERE source = 'discord' AND source_id = ? AND source_account = ?`,
  ).get(message.id, sourceAccount) as StoredDiscordEvent | null;

  if (!stored) return { found: false, edited: false, tombstoneCleared: false };

  const storedRaw = JSON.parse(stored.raw_data) as Record<string, unknown>;
  const freshRaw = buildDiscordMessageRawData(message);
  const edited =
    sourceEditedAt(storedRaw) !== sourceEditedAt(freshRaw) ||
    editFingerprint(storedRaw) !== editFingerprint(freshRaw);
  const tombstoneCleared = stored.source_deleted_observed_at !== null;

  if (!edited) {
    if (tombstoneCleared) {
      db.prepare("UPDATE events SET source_deleted_observed_at = NULL WHERE id = ?").run(stored.id);
    }
    return { found: true, edited: false, tombstoneCleared };
  }

  const nextRaw = mergeEditedFields(storedRaw, freshRaw);
  const renderer = getRenderer("discord");
  if (!renderer) throw new Error("Discord renderer is not registered");
  const rendered = renderer(nextRaw);
  if (rendered.title === null) throw new Error(`Discord event ${message.id} has no channel title`);
  const nextType = getDiscordMessageEventType(message, baseMessageType(stored.type));

  db.transaction(() => {
    db.prepare(
      `INSERT INTO event_versions (event_id, observed_at, source_edited_at, raw_data)
       VALUES (?, ?, ?, ?)`,
    ).run(stored.id, observedAt, sourceEditedAt(storedRaw), stored.raw_data);
    db.prepare(
      `UPDATE events
       SET type = ?, title = ?, content = ?, raw_data = ?, source_deleted_observed_at = NULL
       WHERE id = ?`,
    ).run(nextType, rendered.title, rendered.content, JSON.stringify(nextRaw), stored.id);
  })();

  return { found: true, edited: true, tombstoneCleared };
}

export function tombstoneDiscordMessage(
  db: Database,
  messageId: string,
  sourceAccount: string,
  observedAt = new Date().toISOString(),
): boolean {
  const result = db.prepare(
    `UPDATE events
     SET source_deleted_observed_at = ?
     WHERE source = 'discord' AND source_id = ? AND source_account = ?
       AND source_deleted_observed_at IS NULL`,
  ).run(observedAt, messageId, sourceAccount);
  return result.changes > 0;
}
