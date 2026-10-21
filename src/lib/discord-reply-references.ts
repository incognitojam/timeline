import type { TimelineEvent } from "../db/schema";
import type { QueryExecutor } from "../db/pool";
import {
  getDiscordAuthorId,
  getDiscordAuthorName,
  getDiscordMessageAttachments,
  getDiscordReferencedMessage,
  getDiscordReplyMessageId,
} from "../shared/discord-forward";

export interface DiscordReplyTarget {
  /** Resolved local event id, or null when only the embedded snapshot is known. */
  eventId: number | null;
  conversationId: string | null;
  authorId: string | null;
  /** The name Discord recorded on the message, which may predate the author's current identity. */
  authorName: string | null;
  content: string | null;
  /**
   * The resolved target row's raw_data, for flattening mention tokens in its
   * content with the message's own mentions array (as normal rendering does).
   * Null for embedded-snapshot fallbacks, which carry no mentions array.
   */
  rawData: string | null;
  hasAttachment: boolean;
}

export interface ConversationReplyEvent extends TimelineEvent {
  replied_to?: {
    event_id?: number;
    conversation_id?: string;
    author_name: string | null;
    content: string | null;
    has_attachment: boolean;
  };
}

interface OriginalReplyRow {
  id: number;
  source_id: string;
  source_account: string | null;
  conversation_id: string;
  type: string;
  content: string | null;
  raw_data: string;
}

function referenceKey(sourceAccount: string | null, sourceId: string): string {
  return JSON.stringify([sourceAccount, sourceId]);
}

function hasAttachment(row: OriginalReplyRow): boolean {
  if (row.type.endsWith(":attachment")) return true;
  return getDiscordMessageAttachments(row.raw_data).length > 0;
}

export async function resolveDiscordReplyTargets(
  db: QueryExecutor,
  events: readonly TimelineEvent[],
): Promise<Map<number, DiscordReplyTarget>> {
  const references = events.flatMap((event) => {
    if (event.source !== "discord") return [];
    // Forwards also carry a message_reference (flag-only forwards with
    // type 0/absent included) — the event type is the converter's verdict.
    if (event.type.endsWith(":forward")) return [];
    const messageId = getDiscordReplyMessageId(event.raw_data);
    return messageId ? [{ event, messageId }] : [];
  });
  if (references.length === 0) return new Map();

  const sourceIds = [...new Set(references.map(({ messageId }) => messageId))];
  const placeholders = sourceIds.map(() => "?").join(", ");
  const originals = await db.query<OriginalReplyRow>(`
    SELECT
      e.id,
      e.source_id,
      e.source_account,
      e.conversation_id,
      e.type,
      e.content,
      e.raw_data
    FROM events e
    WHERE e.source = 'discord'
      AND e.source_id IN (${placeholders})
      AND e.conversation_id IS NOT NULL
  `, ...sourceIds);
  const originalsByReference = new Map(
    originals.map((event) => [referenceKey(event.source_account, event.source_id), event]),
  );

  const targets = new Map<number, DiscordReplyTarget>();
  for (const { event, messageId } of references) {
    const original = originalsByReference.get(referenceKey(event.source_account, messageId));
    if (original) {
      targets.set(event.id, {
        eventId: original.id,
        conversationId: original.conversation_id,
        authorId: getDiscordAuthorId(original.raw_data),
        authorName: getDiscordAuthorName(original.raw_data),
        content: original.content,
        rawData: original.raw_data,
        hasAttachment: hasAttachment(original),
      });
      continue;
    }
    // Fall back to Discord's embedded resolved preview when the original message
    // isn't indexed locally (non-clickable preview: no local event id).
    const embedded = getDiscordReferencedMessage(event.raw_data);
    if (embedded && (embedded.authorName || embedded.content || embedded.hasAttachment)) {
      targets.set(event.id, {
        eventId: null,
        conversationId: null,
        authorId: embedded.authorId,
        authorName: embedded.authorName,
        content: embedded.content,
        rawData: null,
        // Legacy snapshots (null) don't record attachments; treat as none —
        // the preview then falls back to the author line alone.
        hasAttachment: embedded.hasAttachment ?? false,
      });
    }
  }
  return targets;
}

export function addDiscordReplyTargets<E extends TimelineEvent>(
  events: readonly E[],
  targets: ReadonlyMap<number, DiscordReplyTarget>,
): (E & ConversationReplyEvent)[] {
  return events.map((event) => {
    const target = targets.get(event.id);
    return target
      ? {
        ...event,
        replied_to: {
          event_id: target.eventId ?? undefined,
          conversation_id: target.conversationId ?? undefined,
          author_name: target.authorName,
          content: target.content,
          has_attachment: target.hasAttachment,
        },
      }
      : event;
  });
}
