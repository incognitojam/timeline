import { getDiscordCallDetails } from "../shared/discord-call";
import { getDiscordSnapshotAttachments, getDiscordStickerItems } from "../shared/discord-forward";
import { isRecord } from "../shared/guards";
import { type NormalizedReaction, normalizeReactions, type ReactionActor } from "../shared/reactions";

export type ReactionActorNameResolver = (actor: ReactionActor) => string;

const binaryByteUnits = ["B", "KiB", "MiB", "GiB"] as const;

export function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/** Precise second-level durations. For coarse h/m spans use formatDuration. */
export function formatPreciseDuration(ms: number | null): string {
  if (ms == null) return "";
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts = [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    remainingSeconds > 0 ? `${remainingSeconds}s` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" ") || "0s";
}

interface DiscordMessageMarkerEvent {
  source?: string;
  type?: string;
  source_account?: string | null;
  timestamp?: string | null;
  raw_data?: string | null;
}

/**
 * Discord call events never carry duration_ms or end_timestamp — neither write
 * path sets them — so both the duration and whether the call was missed come
 * from raw_data.call: the account's absence from participants means missed.
 */
export function getDiscordCallDescription(
  event: DiscordMessageMarkerEvent,
): string | null {
  const details = getDiscordCallDetails(event);
  if (!details) return null;
  if (details.participation === "missed") return "[missed call]";
  const unavailableDescription = details.participation === "answered"
    ? "[call: answered; duration unavailable]"
    : "[call: duration unavailable]";
  return details.durationMs === null
    ? unavailableDescription
    : `[call: ${formatPreciseDuration(details.durationMs)}]`;
}

export function getDiscordStickerDescription(
  event: { source?: string; raw_data?: string | null },
): string | null {
  if (event.source !== "discord") return null;
  const markers = getDiscordStickerItems(event.raw_data)
    .map((sticker) => sticker.name?.trim() ? `[sticker: ${sticker.name}]` : "[sticker]");
  return markers.length > 0 ? markers.join(" ") : null;
}

/** Ordered non-content markers shared by transcript and MCP message renderers. */
export function getMessageMarkers(event: DiscordMessageMarkerEvent, attachmentMarker: string | null): string[] {
  return [
    attachmentMarker,
    getEmbedsDescription(event),
    getDiscordCallDescription(event),
    getDiscordStickerDescription(event),
  ].filter((marker): marker is string => marker !== null);
}

export function formatBinaryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`Cannot format invalid byte count: ${bytes}`);
  }

  if (bytes < 1024) return `${bytes} B`;

  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), binaryByteUnits.length - 1);
  return `${(bytes / 1024 ** unitIndex).toFixed(1)} ${binaryByteUnits[unitIndex]}`;
}

/**
 * Extract a short description from attachments in raw_data, if any.
 * Returns e.g. "[photo]", "[video]", "[audio]", "[file: doc.pdf]",
 * or multiple joined with spaces for multi-attachment messages.
 */
export function getAttachmentDescription(event: { source?: string; raw_data?: string | null }): string | null {
  if (!event.raw_data) return null;
  try {
    const raw = typeof event.raw_data === "string"
      ? JSON.parse(event.raw_data)
      : event.raw_data;
    const attachments = Array.isArray(raw.attachments) ? [...raw.attachments] : [];
    if (event.source === "discord") {
      const seenIds = new Set(attachments
        .map((attachment: { id?: unknown }) => attachment.id)
        .filter((id: unknown): id is string => typeof id === "string"));
      for (const attachment of getDiscordSnapshotAttachments(raw)) {
        if (seenIds.has(attachment.id)) continue;
        attachments.push(attachment);
        seenIds.add(attachment.id);
      }
    }
    if (event.source === "google-messages" && Array.isArray(raw.media)) {
      // Every part the phone reported, fetched or not — the message still carried it.
      for (const media of raw.media as Array<{ mime_type?: string; name?: string }>) {
        attachments.push({ content_type: media.mime_type, filename: media.name });
      }
    }
    if (attachments.length === 0) return null;

    const descs = attachments.map((a: { content_type?: string; filename?: string }) => {
      const ct = a.content_type || "";
      if (ct.startsWith("image/")) return "[photo]";
      if (ct.startsWith("video/")) return "[video]";
      if (ct.startsWith("audio/")) return "[audio]";
      return `[file: ${a.filename || "attachment"}]`;
    });
    return descs.join(" ");
  } catch {
    return null;
  }
}

interface DiscordEmbedData {
  author?: unknown;
  title?: unknown;
  description?: unknown;
  fields?: unknown;
}

function parseRawData(rawData: string | null | undefined): unknown {
  if (!rawData) return null;
  try {
    return typeof rawData === "string" ? JSON.parse(rawData) : rawData;
  } catch {
    return null;
  }
}

function collapseEmbedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed : null;
}

function truncateEmbedDescription(description: string): string {
  return description.length > 300 ? `${description.slice(0, 297)}...` : description;
}

function formatEmbedFields(fields: unknown): string[] {
  if (!Array.isArray(fields)) return [];

  return fields
    .filter(isRecord)
    .map((field) => {
      const name = collapseEmbedText(field.name);
      const value = collapseEmbedText(field.value);
      if (!name || !value) return null;
      return `${name}: ${value}`;
    })
    .filter((field): field is string => field !== null);
}

function collectRawEmbeds(raw: unknown): DiscordEmbedData[] {
  if (!isRecord(raw)) return [];

  const collected: DiscordEmbedData[] = [];
  if (Array.isArray(raw.embeds)) {
    collected.push(...raw.embeds.filter(isRecord));
  }

  if (Array.isArray(raw.message_snapshots)) {
    for (const snapshot of raw.message_snapshots) {
      if (!isRecord(snapshot)) continue;
      const message = snapshot.message;
      if (!isRecord(message) || !Array.isArray(message.embeds)) continue;
      collected.push(...message.embeds.filter(isRecord));
    }
  }

  return collected;
}

function formatEmbedDescription(embed: DiscordEmbedData): string | null {
  const description = collapseEmbedText(embed.description);
  const authorName = isRecord(embed.author) ? collapseEmbedText(embed.author.name) : null;
  const parts = [
    authorName,
    collapseEmbedText(embed.title),
    description ? truncateEmbedDescription(description) : null,
  ].filter((part): part is string => part !== null);

  const fields = formatEmbedFields(embed.fields);
  if (fields.length > 0) parts.push(fields.join("; "));

  return parts.length > 0 ? `[embed: ${parts.join(" — ")}]` : null;
}

/**
 * Extract compact textual descriptions from rich embeds in raw_data, if any.
 * URL-only or media-only embeds are skipped because message text already has
 * the shared link.
 */
export function getEmbedsDescription(event: { raw_data?: string | null }): string | null {
  try {
    const raw = parseRawData(event.raw_data);
    const descriptions = collectRawEmbeds(raw)
      .map(formatEmbedDescription)
      .filter((description): description is string => description !== null);
    return descriptions.length > 0 ? descriptions.join(" ") : null;
  } catch {
    return null;
  }
}

export interface ReactionSummary {
  description: string | null;
  reactionEntries: number;
  summarizedEntries: number;
  skippedEntries: number;
  abortsCurrentConsumer: boolean;
}

function emptyReactionSummary(): ReactionSummary {
  return {
    description: null,
    reactionEntries: 0,
    summarizedEntries: 0,
    skippedEntries: 0,
    abortsCurrentConsumer: false,
  };
}

/**
 * Count the stored raw reaction entries so audits can compare what the
 * formatter consumed against what is present in raw_data.
 */
function countRawReactionEntries(rawData: string | null | undefined): number {
  if (!rawData) return 0;
  try {
    const raw = JSON.parse(rawData);
    return Array.isArray(raw.reactions) ? raw.reactions.length : 0;
  } catch {
    return 0;
  }
}

function formatNormalizedReactions(
  reactions: NormalizedReaction[],
  actorNameResolver: ReactionActorNameResolver = (actor) => actor.name,
): string {
  const parts = reactions.map((reaction) => {
    const label = reaction.custom ? `:${reaction.custom.name}:` : reaction.emoji;
    if (reaction.actors && reaction.actors.length > 0) {
      const actors = reaction.actors.map((actor) => actorNameResolver(actor));
      if (reaction.actors.length === reaction.count) {
        return `${label} ${actors.join(", ")}`;
      }
      return `${label} ×${reaction.count} (${actors.join(", ")})`;
    }
    return `${label} ×${reaction.count}`;
  });
  return `[reactions: ${parts.join("; ")}]`;
}

function countSummarizedEntries(source: string, reactions: NormalizedReaction[]): number {
  return source === "facebook"
    ? reactions.reduce((sum, reaction) => sum + reaction.count, 0)
    : reactions.length;
}

/**
 * Summarize reactions using the current shared reaction normalizer.
 */
export function getReactionSummary(event: { source: string; raw_data?: string | null }): ReactionSummary {
  const reactionEntries = countRawReactionEntries(event.raw_data);
  if (reactionEntries === 0) return emptyReactionSummary();

  const reactions = normalizeReactions(event);
  if (!reactions) {
    return {
      ...emptyReactionSummary(),
      reactionEntries,
      skippedEntries: reactionEntries,
    };
  }

  const summarizedEntries = countSummarizedEntries(event.source, reactions);
  return {
    description: formatNormalizedReactions(reactions),
    reactionEntries,
    summarizedEntries,
    skippedEntries: Math.max(reactionEntries - summarizedEntries, 0),
    abortsCurrentConsumer: false,
  };
}

/**
 * Extract a compact reactions summary from raw_data, if any.
 * Returns e.g. "[reactions: 😮 Alice; :pepe: ×3]" or null when there are none.
 */
export function getReactionsDescription(
  event: { source: string; raw_data?: string | null },
  actorNameResolver?: ReactionActorNameResolver,
): string | null {
  const reactions = normalizeReactions(event);
  if (!reactions) return null;

  return formatNormalizedReactions(reactions, actorNameResolver);
}
