import type { TimelineEvent } from "../db/schema";
import type { QueryExecutor } from "../db/pool";
import { guildIconUrl } from "../db/discord-servers";
import { getDiscordForwardedMessageId } from "../shared/discord-forward";

export interface DiscordForwardTarget {
  eventId: number;
  conversationId: string;
  timestamp: string | null;
  sourceName: string | null;
  sourceIconUrl: string | null;
}

export interface ConversationTimelineEvent extends TimelineEvent {
  forwarded_from?: {
    event_id: number;
    conversation_id: string;
    timestamp: string | null;
    source_name: string | null;
    source_icon_url: string | null;
  };
}

interface OriginalEventRow {
  id: number;
  source_id: string;
  source_account: string | null;
  conversation_id: string;
  timestamp: string | null;
  title: string | null;
  guild_id: string | null;
  guild_name: string | null;
  guild_icon: string | null;
}

function referenceKey(sourceAccount: string | null, sourceId: string): string {
  return JSON.stringify([sourceAccount, sourceId]);
}

export async function resolveDiscordForwardTargets(
  db: QueryExecutor,
  events: readonly TimelineEvent[],
): Promise<Map<number, DiscordForwardTarget>> {
  const references = events.flatMap((event) => {
    if (event.source !== "discord" || !event.type.endsWith(":forward")) return [];
    const sourceId = getDiscordForwardedMessageId(event.raw_data);
    return sourceId ? [{ event, sourceId }] : [];
  });
  if (references.length === 0) return new Map();

  const sourceIds = [...new Set(references.map(({ sourceId }) => sourceId))];
  const placeholders = sourceIds.map(() => "?").join(", ");
  const originals = await db.query<OriginalEventRow>(`
    SELECT
      e.id,
      e.source_id,
      e.source_account,
      e.conversation_id,
      e.timestamp,
      e.title,
      json_extract(e.raw_data, '$._channel.guild_id') AS guild_id,
      json_extract(e.raw_data, '$._channel.guild_name') AS guild_name,
      g.icon AS guild_icon
    FROM events e
    LEFT JOIN discord_guilds g
      ON g.guild_id = json_extract(e.raw_data, '$._channel.guild_id')
    WHERE e.source = 'discord'
      AND e.source_id IN (${placeholders})
      AND e.conversation_id IS NOT NULL
  `, ...sourceIds);
  const originalsByReference = new Map(
    originals.map((event) => [referenceKey(event.source_account, event.source_id), event]),
  );

  const targets = new Map<number, DiscordForwardTarget>();
  for (const { event, sourceId } of references) {
    const original = originalsByReference.get(referenceKey(event.source_account, sourceId));
    if (!original) continue;
    targets.set(event.id, {
      eventId: original.id,
      conversationId: original.conversation_id,
      timestamp: original.timestamp,
      sourceName: original.guild_name ?? original.title,
      sourceIconUrl: original.guild_id
        ? guildIconUrl(original.guild_id, original.guild_icon ?? undefined)
        : null,
    });
  }
  return targets;
}

export function addDiscordForwardTargets(
  events: readonly TimelineEvent[],
  targets: ReadonlyMap<number, DiscordForwardTarget>,
): ConversationTimelineEvent[] {
  return events.map((event) => {
    const target = targets.get(event.id);
    return target
      ? {
        ...event,
        forwarded_from: {
          event_id: target.eventId,
          conversation_id: target.conversationId,
          timestamp: target.timestamp,
          source_name: target.sourceName,
          source_icon_url: target.sourceIconUrl,
        },
      }
      : event;
  });
}
