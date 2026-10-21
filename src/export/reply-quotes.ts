import { convertLegacyEmoji } from "../db/emoji";
import { resolveIdentities } from "../db/identities";
import type { QueryExecutor } from "../db/pool";
import type { TimelineEvent } from "../db/schema";
import {
  resolveDiscordReplyTargets,
  type DiscordReplyTarget,
} from "../lib/discord-reply-references";
import { discordMentionsToPlainText, extractUserMentionIds } from "../shared/discord-mentions";
import { quotePreview } from "./quote-preview";

/** Inline reply-quote markers keyed by the replying event's id. */
export type ReplyQuotesByEvent = ReadonlyMap<number, string>;

function quotedText(
  target: DiscordReplyTarget,
  discordUserResolver?: (id: string) => string | null,
  timeZone?: string,
): string | null {
  const raw = convertLegacyEmoji(target.content)?.trim();
  const plain = raw
    ? quotePreview(discordMentionsToPlainText(raw, target.rawData, { user: discordUserResolver }, { timeZone }))
    : "";
  return plain || (target.hasAttachment ? "[attachment]" : null);
}

/**
 * Build inline quote markers for Discord replies, Discord-style:
 *
 *   ↪ (to Alice: "Are we still on for the quiz tonight?")
 *
 * Resolution mirrors the API decorator (resolveDiscordReplyTargets): the
 * locally indexed original first, then the embedded referenced_message
 * snapshot; events whose target resolves nowhere get no marker at all.
 * Renderers prepend the marker to the reply's own message text.
 */
export async function loadReplyQuotesForEvents(
  db: QueryExecutor,
  events: readonly TimelineEvent[],
  options: {
    discordUserResolver?: (id: string) => string | null;
    /** Renders the quoted author, given the identifier their own message lines use. */
    participantNameResolver?: (name: string, identifier?: string) => string;
    /** Zone for inline `<t:…>` timestamps, so a quote reads like the message it quotes. */
    timeZone?: string;
  } = {},
): Promise<Map<number, string>> {
  const targets = await resolveDiscordReplyTargets(db, events);

  // Quoted authors and their mentions can be absent from the export window,
  // which is all the caller's resolver covers.
  const identifiers = new Set<string>();
  for (const target of targets.values()) {
    if (target.authorId) identifiers.add(`discord:${target.authorId}`);
    if (!target.content) continue;
    for (const id of extractUserMentionIds(target.content)) {
      identifiers.add(`discord:${id}`);
    }
  }
  const identities = identifiers.size > 0 ? await resolveIdentities(db, [...identifiers]) : {};
  const resolver = (id: string): string | null =>
    options.discordUserResolver?.(id) ?? identities[`discord:${id}`]?.name ?? null;

  const quotes = new Map<number, string>();
  for (const [eventId, target] of targets) {
    const author = authorName(target, identities, options.participantNameResolver);
    const text = quotedText(target, resolver, options.timeZone);
    quotes.set(eventId, text ? `↪ (to ${author}: "${text}")` : `↪ (to ${author})`);
  }
  return quotes;
}

function authorName(
  target: DiscordReplyTarget,
  identities: Record<string, { name: string | null }>,
  participantNameResolver?: (name: string, identifier?: string) => string,
): string {
  const identifier = target.authorId ? `discord:${target.authorId}` : undefined;
  const name = (identifier ? identities[identifier]?.name : null) ?? target.authorName;
  if (!name) return "unknown";
  return participantNameResolver?.(name, identifier) ?? name;
}
