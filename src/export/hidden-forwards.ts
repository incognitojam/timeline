import { hiddenEventIdsAmong } from "../db/events";
import type { QueryExecutor } from "../db/pool";
import type { TimelineEvent } from "../db/schema";
import { getDiscordForwardedMessageId } from "../platforms/discord/shared/forward";

type ForwardFields = Pick<TimelineEvent, "id" | "source" | "source_account"> & { raw_data: string | null };

/**
 * The ids of the events that are Discord forwards of a hidden contact's
 * message: a forward is filed under whoever forwarded it, but carries the
 * original's text in its content, its raw_data snapshot and its attachments.
 */
export async function hiddenForwardIds(db: QueryExecutor, events: readonly ForwardFields[]): Promise<Set<number>> {
  const forwards = events.flatMap((event) => {
    const messageId = event.source === "discord" ? getDiscordForwardedMessageId(event.raw_data) : null;
    return messageId ? [{ event, messageId }] : [];
  });
  if (forwards.length === 0) return new Set();
  const originals = await db.query<{ id: number; source_id: string; source_account: string | null }>(
    `SELECT id, source_id, source_account FROM events WHERE source = 'discord' AND source_id IN (${forwards.map(() => "?").join(", ")})`,
    ...forwards.map((f) => f.messageId),
  );
  const hidden = await hiddenEventIdsAmong(db, originals.map((o) => o.id));
  const hiddenKeys = new Set(originals.filter((o) => hidden.has(o.id)).map((o) => `${o.source_account}\u0000${o.source_id}`));
  return new Set(forwards
    .filter((f) => hiddenKeys.has(`${f.event.source_account}\u0000${f.messageId}`))
    .map((f) => f.event.id));
}

/** The events with every forward of a hidden contact's message emptied, and the ids of those forwards. */
export async function maskForwardsOfHiddenEvents(
  db: QueryExecutor,
  shown: TimelineEvent[],
): Promise<{ events: TimelineEvent[]; masked: Set<number> }> {
  const masked = await hiddenForwardIds(db, shown);
  if (masked.size === 0) return { events: shown, masked };
  const events = shown.map((event) => {
    if (!masked.has(event.id)) return event;
    const raw = JSON.parse(event.raw_data ?? "{}") as Record<string, unknown>;
    delete raw.message_snapshots;
    return { ...event, content: null, raw_data: JSON.stringify(raw) };
  });
  return { events, masked };
}
