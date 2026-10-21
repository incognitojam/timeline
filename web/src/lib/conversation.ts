import { getDiscordCallDetails } from "@shared/discord-call";
import {
  type DiscordRawAttachment,
  getDiscordForwardedText,
  getDiscordMessageAttachments,
} from "@shared/discord-forward";
import { type NormalizedReaction, normalizeReactions } from "@shared/reactions";
import {
  IconBlock,
  IconCamera,
  type IconComponent,
  IconFormatPaint,
  IconGifBox,
  IconHowToVote,
  IconLink,
  IconMic,
  IconMovie,
  IconPhone,
} from "../ui/icons";
import { formatDateSeparator } from "./format";
import { getSenderIdentifier } from "./identities";
import { buildConversationUrl } from "./routes";
import type { TimelineEvent } from "./types";

export type Reaction = NormalizedReaction;

export interface ForwardedMessageSource {
  url: string;
  name: string;
  iconUrl: string | null;
  timestamp: string | null;
}

export const CONVERSATION_AUTO_REFETCH_INTERVAL_MS = 5_000;

export function reverseEventsChronologically(events: readonly TimelineEvent[]): TimelineEvent[] {
  return [...events].reverse();
}

export function getReactions(event: TimelineEvent): Reaction[] | null {
  return normalizeReactions(event);
}

/**
 * For a Discord forwarded message, extract the snapshot content text if it
 * exists. Returns null for forwards with no text body (e.g. forwarded image)
 * or events where snapshots weren't captured (historical forwards synced
 * before PR #253).
 */
export function isDiscordForwardedEvent(event: TimelineEvent): boolean {
  return event.source === "discord" && event.type.split(":").pop() === "forward";
}

export function getForwardedText(event: TimelineEvent): string | null {
  if (!isDiscordForwardedEvent(event)) return null;
  return getDiscordForwardedText(event.raw_data);
}

export function getForwardedMessageSource(event: TimelineEvent): ForwardedMessageSource | null {
  if (!isDiscordForwardedEvent(event) || event.forwarded_from === undefined) return null;
  return {
    url: buildConversationUrl(
      event.source,
      event.forwarded_from.conversation_id,
      event.forwarded_from.event_id,
    ),
    name: event.forwarded_from.source_name ?? "Original message",
    iconUrl: event.forwarded_from.source_icon_url,
    timestamp: event.forwarded_from.timestamp,
  };
}

export interface ReplyTarget {
  /** In-conversation link to the original message, or null when unresolved. */
  url: string | null;
  eventId: number | null;
  conversationId: string | null;
  authorName: string | null;
  content: string | null;
  hasAttachment: boolean;
}

/**
 * The message a Discord reply points at, derived from the API's `replied_to`
 * field. Returns null for non-reply events. A resolved target carries a `url`
 * and `eventId` for navigation/scroll; an unresolved fallback preview has both
 * null and renders non-clickable.
 */
export function getReplyTarget(event: TimelineEvent): ReplyTarget | null {
  if (event.source !== "discord" || event.replied_to === undefined) return null;
  const reply = event.replied_to;
  const eventId = reply.event_id ?? null;
  const conversationId = reply.conversation_id ?? null;
  return {
    url: eventId !== null && conversationId !== null
      ? buildConversationUrl(event.source, conversationId, eventId)
      : null,
    eventId,
    conversationId,
    authorName: reply.author_name,
    content: reply.content,
    hasAttachment: reply.has_attachment,
  };
}

/** Canonical message text, including historical Discord forwards with null content. */
export function getConversationContent(event: TimelineEvent): string | null {
  return event.content || getForwardedText(event);
}

/** Discord attachments from either the message wrapper or a forwarded snapshot. */
export function getDiscordAttachments(event: TimelineEvent): DiscordRawAttachment[] | null {
  if (event.source !== "discord") return null;
  const attachments = getDiscordMessageAttachments(event.raw_data);
  return attachments.length > 0 ? attachments : null;
}

/** Display info for the badge shown beside a message's sender header. */
export interface MessageTypeInfo {
  icon: IconComponent;
  label: string;
  className: string;
}

export function getMessageTypeInfo(event: TimelineEvent): MessageTypeInfo | null {
  if (!event.type.startsWith("message:")) return null;

  const subtype = event.type.split(":").pop();
  switch (subtype) {
    case "call":
      return { icon: IconPhone, label: "Call", className: "text-green-400" };
    case "photo":
      return { icon: IconCamera, label: "Photo", className: "text-blue-400" };
    case "video":
      return { icon: IconMovie, label: "Video", className: "text-purple-400" };
    case "share":
      return { icon: IconLink, label: "Shared", className: "text-cyan-400" };
    case "sticker":
      return { icon: IconFormatPaint, label: "Sticker", className: "text-pink-400" };
    case "gif":
      return { icon: IconGifBox, label: "GIF", className: "text-orange-400" };
    case "audio":
      return { icon: IconMic, label: "Voice", className: "text-amber-400" };
    case "unsent":
      return { icon: IconBlock, label: "Unsent", className: "text-red-400" };
    case "poll":
      return { icon: IconHowToVote, label: "Poll", className: "text-gray-400" };
    default:
      return null;
  }
}

export interface MessageCallInfo {
  missed: boolean;
  durationMs: number | null;
}

/** Call state for the message header, including Discord's raw call metadata. */
export function getMessageCallInfo(event: TimelineEvent): MessageCallInfo | null {
  if (!event.type.startsWith("message:") || event.type.split(":").pop() !== "call") {
    return null;
  }

  const discordCall = getDiscordCallDetails(event);
  if (discordCall) {
    return {
      missed: discordCall.participation === "missed",
      durationMs: discordCall.participation === "missed" ? null : discordCall.durationMs,
    };
  }

  const missed = event.type === "message:call" && event.duration_ms === 0;
  return { missed, durationMs: missed ? null : event.duration_ms };
}

/**
 * The ids of events that render a sender header (avatar, name, timestamp);
 * every other event continues the run above it and renders bare content, the
 * same collapsing the export renderer does when it omits repeated authors.
 *
 * A run breaks when the event:
 *  - is the first of the conversation, or changes sender, or opens a new date
 *    group (a single sender's run straddling midnight must re-label under the
 *    sticky date header);
 *  - is a reply (its quoted preview needs its own attribution);
 *  - carries a message type badge (call, photo, …) which renders on the header
 *    line and would otherwise be dropped;
 *  - is listed in `forcedHeaderIds` — events an inline separator is drawn above
 *    ("Renamed to X", "User selected X"), which visually cut the run.
 */
export function computeSenderHeaderIds(
  events: readonly TimelineEvent[],
  forcedHeaderIds?: ReadonlySet<number>,
): Set<number> {
  const ids = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const curr = events[i];
    if (!curr) continue;
    const prev = i > 0 ? events[i - 1] : null;
    if (
      !prev ||
      forcedHeaderIds?.has(curr.id) ||
      getSenderIdentifier(curr) !== getSenderIdentifier(prev) ||
      formatDateSeparator(curr.timestamp) !== formatDateSeparator(prev.timestamp) ||
      getReplyTarget(curr) !== null ||
      getMessageTypeInfo(curr) !== null
    ) {
      ids.add(curr.id);
    }
  }
  return ids;
}

// Check if content is just a placeholder that duplicates type badge or attachment preview
export function isPlaceholderContent(content: string | null, type: string, shareLink?: string | null): boolean {
  if (!content) return false;
  const lower = content.toLowerCase().trim();

  // Media placeholders
  if (lower === "[photo]" || lower === "[video]" || lower === "[sticker]" ||
      lower === "[gif]" || lower === "[voice message]" || lower === "[unsent message]" ||
      lower === "[shared link]" || lower === "[poll data not exported by facebook]") {
    return true;
  }

  // Call duration pattern: "Xm Ys call" or "The video call ended."
  if (type.includes("call")) {
    if (/^\d+m \d+s call$/i.test(lower) || lower.includes("call ended")) {
      return true;
    }
  }

  // Share: if content is just the URL, it duplicates the share preview
  if (type.includes("share") && shareLink) {
    const trimmedContent = content.trim();
    if (trimmedContent === shareLink || trimmedContent === shareLink.replace(/\/$/, "")) {
      return true;
    }
  }

  return false;
}
