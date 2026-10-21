/**
 * Google Messages importer.
 *
 * Consumes the JSONL stream produced by `tools/timeline-gmessages dump` (one
 * record per line, tagged by `kind`; conversation records precede their
 * messages, and each conversation ends with `conversation_done` or
 * `conversation_error`) and writes `google-messages` events. Identities use
 * the `phone` platform — a number is the same person whichever app captured
 * it — and the conversation key is derived from participant numbers exactly
 * like the SMS Backup & Restore parser's, so the two histories line up per
 * conversation once sources are unified.
 */
import type { Database, Statement } from "bun:sqlite";
import { readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { extractConversationId } from "../../db/conversation-id";
import { formatIdentifier, upsertIdentities, type UpsertIdentityOptions } from "../../db/identities";
import { onImportComplete } from "../../db/import-hooks";
import { isPhoneNumberLike, normalizePhoneNumber, PHONE_IDENTITY_PLATFORM as IDENTITY_PLATFORM } from "../../lib/phone";
import { type AttachmentInput, markAttachmentFailed, markAttachmentUnrecoverable, storeAndInsertAttachment } from "../../media/attachments";
import { imageDimensions } from "../../media/dimensions";

export const EVENT_SOURCE = "google-messages";

export interface GmParticipant {
  participant_id: string;
  number?: string;
  name?: string;
  is_me: boolean;
  /** Conversations also list stale/alternate identities for a number as invisible participants. */
  visible?: boolean;
}

export interface GmConversation {
  kind: "conversation";
  id: string;
  name?: string;
  folder: string;
  is_group: boolean;
  type: string;
  participants: GmParticipant[];
  last_message_ts_ms?: number;
}

/** One attachment part of a message, downloaded by the sidecar when it runs with `-media`. */
export interface GmMedia {
  media_id: string;
  name?: string;
  mime_type?: string;
  format?: string;
  size?: number;
  width?: number;
  height?: number;
  /**
   * `stored` = the full-size file was decrypted to `path`; `thumbnail` = only
   * Google's smaller copy could be unlocked and that is what `path` holds;
   * `unavailable` = neither copy had a decryption key; `failed` = download error.
   */
  status?: "stored" | "thumbnail" | "failed" | "unavailable";
  /** Where the sidecar wrote the file; relative paths resolve against ImportOptions.mediaDir. */
  path?: string;
}

export interface GmMessage {
  kind: "message";
  id: string;
  conversation_id: string;
  timestamp_ms: number;
  /** `system` = a tombstone banner ("Texting with … (SMS/MMS)", joins, renames), not something a person sent. */
  direction: "incoming" | "outgoing" | "system" | "unknown";
  message_type: string;
  /** MessageStatusType name from the protocol. */
  status?: string;
  sender_participant_id?: string;
  sender_number?: string;
  sender_name?: string;
  text?: string;
  subject?: string;
  reply_to?: string;
  reactions?: string[];
  media?: GmMedia[];
}

export interface GmContact {
  kind: "contact";
  participant_id: string;
  contact_id?: string;
  name?: string;
  number?: string;
}

/** All pages of a conversation were fetched; its cursor may advance. */
export interface GmConversationDone {
  kind: "conversation_done";
  id: string;
  messages: number;
}

/** A conversation could not be fully paged; its cursor must not advance. */
export interface GmConversationError {
  kind: "conversation_error";
  id: string;
  error: string;
}

export type GmRecord = GmConversation | GmMessage | GmContact | GmConversationDone | GmConversationError;

export interface ImportStats {
  imported: number;
  /** Already imported by a previous run (same source_id). */
  skipped: number;
  conversations: number;
  conversationsDone: number;
  /** Conversation ids the sidecar could not fully page. */
  conversationsFailed: string[];
  identities: number;
  /** Messages whose status code did not classify as incoming or outgoing (stored as received). */
  unknownDirection: number;
  /** Tombstone banners skipped (see GmMessage.direction). */
  systemSkipped: number;
  /** Attachments copied into media storage at full size. */
  attachmentsStored: number;
  /** Attachments stored as Google's smaller copy, the full-size one being locked. */
  attachmentsThumbnails: number;
  /** Attachments the sidecar could not download; recorded as failed. */
  attachmentsFailed: number;
  /** Attachments with no decryption key for either copy; recorded as unrecoverable. */
  attachmentsUnavailable: number;
}

export interface ImportOptions {
  /** Stored as source_account; also the owner identity when a conversation carries no self number. */
  sourceAccount: string;
  importBatch: string;
  /** Called once a conversation is completely imported, so callers can persist its cursor. */
  onConversationDone?: (conversationId: string) => void;
  /**
   * Directory the sidecar downloaded media into (its `-media` flag). Required
   * when a message carries stored media; each file is removed once it has been
   * copied into media storage.
   */
  mediaDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Google Messages record missing "${key}": ${JSON.stringify(record).slice(0, 200)}`);
  }
  return value;
}

function validateConversation(value: Record<string, unknown>): GmConversation {
  requireString(value, "id");
  if (!Array.isArray(value.participants)) throw new Error(`Conversation ${value.id} has no participants array`);
  for (const participant of value.participants) {
    if (!isRecord(participant) || typeof participant.participant_id !== "string") {
      throw new Error(`Conversation ${value.id} has a malformed participant (need participant objects; rebuild timeline-gmessages?)`);
    }
  }
  return value as unknown as GmConversation;
}

function validateMessage(value: Record<string, unknown>): GmMessage {
  requireString(value, "id");
  requireString(value, "conversation_id");
  if (typeof value.timestamp_ms !== "number" || !Number.isFinite(value.timestamp_ms)) {
    throw new Error(`Message ${value.id} has no numeric timestamp_ms`);
  }
  return value as unknown as GmMessage;
}

/** Validate one JSONL line at the boundary; malformed input fails the import loudly. */
export function parseRecord(line: string): GmRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid Google Messages JSONL line: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error("Google Messages record is not an object");
  switch (value.kind) {
    case "conversation":
      return validateConversation(value);
    case "message":
      return validateMessage(value);
    case "contact":
      requireString(value, "participant_id");
      return value as unknown as GmContact;
    case "conversation_done":
      requireString(value, "id");
      return value as unknown as GmConversationDone;
    case "conversation_error":
      requireString(value, "id");
      return value as unknown as GmConversationError;
    default:
      throw new Error(`Unknown Google Messages record kind: ${String(value.kind)}`);
  }
}

const MESSAGE_FAMILIES = new Set(["sms", "mms", "rcs"]);

/** `sms:*` / `mms:*` / `rcs:*` by transport; unknown transports fall back to sms. */
export function eventTypeFor(message: GmMessage): string {
  const family = MESSAGE_FAMILIES.has(message.message_type) ? message.message_type : "sms";
  const direction = message.direction === "outgoing" ? "sent" : "received";
  return `${family}:${direction}`;
}

/**
 * The conversation's counterparties: visible, non-self participants, one per
 * normalized number (a conversation lists the same person under national and
 * international forms, the older one marked invisible).
 */
export function counterparties(conversation: GmConversation): GmParticipant[] {
  const byNumber = new Map<string, GmParticipant>();
  const visible = conversation.participants.filter((p) => !p.is_me && p.visible !== false);
  for (const participant of visible) {
    const key = participant.number ? normalizePhoneNumber(participant.number) : `id:${participant.participant_id}`;
    const existing = byNumber.get(key);
    if (!existing || (participant.name && !existing.name)) byNumber.set(key, participant);
  }
  return [...byNumber.values()];
}

/** The owner's own number in this conversation (which SIM it ran on), if the phone reports one. */
export function selfParticipant(conversation: GmConversation): GmParticipant | undefined {
  return conversation.participants.find((p) => p.is_me && p.number);
}

/**
 * Counterparty address in the `~`-joined shape the phone conversation key
 * expects (see extractConversationId), so a chat keys identically however it
 * was captured.
 */
export function conversationAddress(conversation: GmConversation): string {
  const numbers = counterparties(conversation)
    .map((p) => (p.number ?? "").trim())
    .filter((n) => n !== "");
  if (numbers.length > 0) return numbers.sort().join("~");
  return `gm:${conversation.id}`;
}

function participantLabel(participant: GmParticipant | undefined, fallback: string): string {
  if (!participant) return fallback;
  return participant.name || participant.number || fallback;
}

function participantIdentifier(participant: GmParticipant | undefined, fallbackId: string): string {
  if (participant?.number) return formatIdentifier(IDENTITY_PLATFORM, normalizePhoneNumber(participant.number));
  if (participant?.name) return formatIdentifier(IDENTITY_PLATFORM, participant.name.trim());
  return formatIdentifier(IDENTITY_PLATFORM, `gm-participant-${fallbackId}`);
}

function identityFor(participant: GmParticipant): UpsertIdentityOptions | null {
  if (!participant.number) return null;
  const name = participant.name?.trim();
  return {
    platform: IDENTITY_PLATFORM,
    platformId: normalizePhoneNumber(participant.number),
    displayName: name && !isPhoneNumberLike(name) ? name : undefined,
  };
}

/** Title in the SMS Backup & Restore style: group name, else the counterparty. */
function titleFor(conversation: GmConversation, others: GmParticipant[], address: string): string {
  const groupName = conversation.name?.trim();
  if (groupName) return groupName;
  if (others.length === 1) return participantLabel(others[0], address);
  return others.map((p) => participantLabel(p, p.participant_id)).join(", ") || address;
}

/** The sender as listed in the conversation, else as carried on the message itself. */
function senderOf(conversation: GmConversation, message: GmMessage): GmParticipant | undefined {
  const listed = message.sender_participant_id
    ? conversation.participants.find((p) => p.participant_id === message.sender_participant_id)
    : undefined;
  if (listed) return listed;
  if (!message.sender_number) return undefined;
  return { participant_id: message.sender_participant_id ?? "", number: message.sender_number, name: message.sender_name, is_me: false };
}

interface ImportContext {
  db: Database;
  options: ImportOptions;
  stats: ImportStats;
  conversations: Map<string, GmConversation>;
  identities: Map<string, UpsertIdentityOptions>;
  insert: Statement;
  findEvent: Statement;
}

function rememberIdentity(ctx: ImportContext, identity: UpsertIdentityOptions | null): void {
  if (!identity) return;
  const key = `${identity.platform}:${identity.platformId}`;
  const existing = ctx.identities.get(key);
  if (!existing || (identity.displayName && !existing.displayName)) ctx.identities.set(key, identity);
}

function requireConversation(ctx: ImportContext, id: string, forWhat: string): GmConversation {
  const conversation = ctx.conversations.get(id);
  if (!conversation) throw new Error(`${forWhat} references unknown conversation ${id}`);
  return conversation;
}

function handleConversation(ctx: ImportContext, record: GmConversation): void {
  ctx.conversations.set(record.id, record);
  ctx.stats.conversations++;
  for (const participant of counterparties(record)) rememberIdentity(ctx, identityFor(participant));
  const self = selfParticipant(record);
  if (self) rememberIdentity(ctx, identityFor(self));
}

async function handleMessage(ctx: ImportContext, record: GmMessage): Promise<void> {
  const conversation = requireConversation(ctx, record.conversation_id, `Message ${record.id}`);
  if (record.direction === "system") {
    ctx.stats.systemSkipped++;
    return;
  }
  if (record.direction !== "incoming" && record.direction !== "outgoing") ctx.stats.unknownDirection++;

  const others = counterparties(conversation);
  const self = selfParticipant(conversation);
  const ownerIdentifier = self ? participantIdentifier(self, self.participant_id) : formatIdentifier(IDENTITY_PLATFORM, ctx.options.sourceAccount);
  const address = conversationAddress(conversation);
  const rawData = {
    ...record,
    // The staging path is transient; the attachments table holds the stored copy.
    ...(record.media ? { media: record.media.map(({ path: _path, ...media }) => media) } : {}),
    address,
    participants: conversation.participants,
    conversation_type: conversation.type,
    // INBOX / ARCHIVE / SPAM_BLOCKED — lets spam be told apart later.
    folder: conversation.folder,
  };
  const conversationId = extractConversationId(EVENT_SOURCE, rawData);
  if (!conversationId) throw new Error(`No conversation id derivable for message ${record.id}`);

  const sender = senderOf(conversation, record);
  if (sender && !sender.is_me) rememberIdentity(ctx, identityFor(sender));
  const people =
    record.direction === "outgoing"
      ? [ownerIdentifier, ...others.map((p) => participantIdentifier(p, p.participant_id))]
      : [participantIdentifier(sender, record.sender_participant_id ?? "unknown"), ownerIdentifier];

  const inserted = ctx.insert.get(
    EVENT_SOURCE,
    record.id,
    ctx.options.sourceAccount,
    eventTypeFor(record),
    new Date(record.timestamp_ms).toISOString(),
    titleFor(conversation, others, address),
    record.text ?? "",
    JSON.stringify(people),
    JSON.stringify(rawData),
    ctx.options.importBatch,
    conversationId,
  ) as { id: number } | null;
  if (inserted) ctx.stats.imported++;
  else ctx.stats.skipped++;

  if (record.media && record.media.length > 0) {
    // A re-fetched message (cursor overlap, or a re-run to backfill media) is
    // skipped as an event but still gets its attachments recorded.
    const eventId = inserted?.id ?? existingEventId(ctx, record.id);
    await storeMedia(ctx, eventId, record, conversationId);
  }
}

function existingEventId(ctx: ImportContext, sourceId: string): number {
  const row = ctx.findEvent.get(EVENT_SOURCE, sourceId, ctx.options.sourceAccount) as { id: number } | null;
  if (!row) throw new Error(`Message ${sourceId} was neither inserted nor already present`);
  return row.id;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/mpeg": ".mp3",
  "audio/mpeg3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/amr": ".amr",
  "audio/ogg": ".ogg",
  "text/vcard": ".vcf",
  "text/x-vcard": ".vcf",
  "application/pdf": ".pdf",
};

/** The phone's file name when it has one, else the part id with the extension its MIME type implies. */
function mediaFilename(media: GmMedia, partId: string): string {
  const name = media.name ? basename(media.name.trim()) : "";
  if (name !== "" && name !== "." && name !== "..") return name;
  const ext = media.mime_type ? (EXTENSION_BY_MIME[media.mime_type.toLowerCase()] ?? "") : "";
  return `${flattenPartId(partId)}${ext}`;
}

/**
 * Identity of one part within its message, used as the attachment's source_id.
 * A part the phone withholds carries no media id at all, so fall back to its
 * position — stable across re-imports, since parts arrive in the order the
 * stored message lists them.
 */
function partIdFor(media: GmMedia, index: number): string {
  return media.media_id === "" || media.media_id === undefined ? `part:${index}` : media.media_id;
}

/** Part ids can contain "/" and ":" — flatten so everything lands in one directory. */
function flattenPartId(partId: string): string {
  return partId.replaceAll("/", "_").replaceAll(":", "_");
}

async function dimensionsOf(media: GmMedia, content: Buffer): Promise<{ width: number | null; height: number | null }> {
  // The phone declares the full-size dimensions, so they describe a different
  // file when the thumbnail is what we managed to store: measure that instead.
  if (media.status !== "thumbnail" && media.width && media.height) {
    return { width: media.width, height: media.height };
  }
  if (!media.mime_type?.startsWith("image/")) return { width: null, height: null };
  try {
    return await imageDimensions(content);
  } catch {
    // Undecodable image (e.g. HEIC): stored without dimensions, as the Facebook extractor does.
    return { width: null, height: null };
  }
}

/**
 * Record each attachment part of a message. Downloaded files move from the
 * sidecar's staging directory into content-addressed media storage; parts the
 * sidecar could not fetch get a terminal status so the message still shows
 * what it carried.
 */
async function storeMedia(ctx: ImportContext, eventId: number, message: GmMessage, conversationId: string): Promise<void> {
  const parts = message.media ?? [];
  for (const [index, media] of parts.entries()) {
    const partId = partIdFor(media, index);
    const filename = mediaFilename(media, partId);
    const attachment: AttachmentInput = {
      eventId,
      source: EVENT_SOURCE,
      sourceId: partId,
      filename,
      mimeType: media.mime_type ?? null,
      fileSize: media.size || null,
      width: media.width || null,
      height: media.height || null,
    };
    if (media.status === "unavailable") {
      markAttachmentUnrecoverable(ctx.db, attachment);
      ctx.stats.attachmentsUnavailable++;
      continue;
    }
    const downloaded = media.status === "stored" || media.status === "thumbnail";
    if (!downloaded || !media.path) {
      markAttachmentFailed(ctx.db, attachment);
      ctx.stats.attachmentsFailed++;
      continue;
    }
    if (!ctx.options.mediaDir) {
      throw new Error(`Message ${message.id} carries downloaded media but the import was given no mediaDir`);
    }
    const path = resolve(ctx.options.mediaDir, media.path);
    const content = await readFile(path);
    const dims = await dimensionsOf(media, content);
    await storeAndInsertAttachment(
      ctx.db,
      { ...attachment, ...dims },
      content,
      join(conversationId, `${flattenPartId(partId)}-${filename}`),
    );
    await rm(path, { force: true });
    if (media.status === "thumbnail") ctx.stats.attachmentsThumbnails++;
    else ctx.stats.attachmentsStored++;
  }
}

async function handleRecord(ctx: ImportContext, record: GmRecord): Promise<void> {
  switch (record.kind) {
    case "contact":
      if (record.number) {
        rememberIdentity(ctx, identityFor({ participant_id: record.participant_id, number: record.number, name: record.name, is_me: false }));
      }
      return;
    case "conversation":
      handleConversation(ctx, record);
      return;
    case "conversation_done":
      requireConversation(ctx, record.id, `Completion of ${record.id}`);
      ctx.stats.conversationsDone++;
      ctx.options.onConversationDone?.(record.id);
      return;
    case "conversation_error":
      ctx.stats.conversationsFailed.push(record.id);
      return;
    case "message":
      await handleMessage(ctx, record);
      return;
  }
}

export async function importGoogleMessages(
  db: Database,
  lines: Iterable<string> | AsyncIterable<string>,
  options: ImportOptions,
): Promise<ImportStats> {
  const ctx: ImportContext = {
    db,
    options,
    stats: {
      imported: 0,
      skipped: 0,
      conversations: 0,
      conversationsDone: 0,
      conversationsFailed: [],
      identities: 0,
      unknownDirection: 0,
      systemSkipped: 0,
      attachmentsStored: 0,
      attachmentsThumbnails: 0,
      attachmentsFailed: 0,
      attachmentsUnavailable: 0,
    },
    conversations: new Map(),
    identities: new Map(),
    insert: db.prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, people, raw_data, import_batch, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `),
    findEvent: db.prepare("SELECT id FROM events WHERE source = ? AND source_id = ? AND source_account = ?"),
  };

  for await (const line of lines) {
    if (line.trim() === "") continue;
    await handleRecord(ctx, parseRecord(line));
  }

  if (ctx.identities.size > 0) {
    upsertIdentities(db, [...ctx.identities.values()]);
    ctx.stats.identities = ctx.identities.size;
  }
  onImportComplete(db);
  return ctx.stats;
}
