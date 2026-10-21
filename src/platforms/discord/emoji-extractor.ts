/**
 * Discord Emoji Extractor
 *
 * Walks a Discord message and pulls every reference to a custom emoji
 * (reactions, inline content, referenced/forwarded message content) into a
 * deduped list. Designed to accept either the live API shape (DiscordMessage)
 * or the post-converter raw_data JSON the backfill script will read.
 */

import { extractCustomEmojiRefs } from "../../shared/discord-mentions";

export interface EmojiRef {
  id: string;
  name: string;
  /** true / false when known; null when reaction lacked the flag and inline content didn't disambiguate. */
  animated: boolean | null;
}

interface ReactionLike {
  emoji?: { id?: string | null; name?: string; animated?: boolean } | null;
}

interface MessageLike {
  content?: string;
  reactions?: ReactionLike[] | null;
  // Both shapes accepted: snake_case from converter raw_data, camelCase from
  // the live NormalizedMessage used by sync + tier-rescan.
  referenced_message?: { content?: string } | null;
  referencedMessage?: { content?: string } | null;
  message_snapshots?: Array<{ message?: { content?: string } | null } | null> | null;
  snapshots?: Array<{ message?: { content?: string } | null } | null> | null;
}

function isMessageLike(v: unknown): v is MessageLike {
  return typeof v === "object" && v !== null;
}

/**
 * Merge two known/unknown animated signals, preferring `true` over `false`
 * over `null` (unknown).
 */
function mergeAnimated(a: boolean | null, b: boolean | null): boolean | null {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}

function pushOrMerge(map: Map<string, EmojiRef>, ref: EmojiRef): void {
  const existing = map.get(ref.id);
  if (!existing) {
    map.set(ref.id, { ...ref });
    return;
  }
  existing.name = ref.name || existing.name;
  existing.animated = mergeAnimated(existing.animated, ref.animated);
}

function collectFromContent(content: string | undefined, map: Map<string, EmojiRef>): void {
  if (!content) return;
  for (const ref of extractCustomEmojiRefs(content)) {
    pushOrMerge(map, { id: ref.id, name: ref.name, animated: ref.animated });
  }
}

export function extractEmojiRefs(input: unknown): EmojiRef[] {
  if (!isMessageLike(input)) return [];
  const message = input;
  const refs = new Map<string, EmojiRef>();

  for (const r of message.reactions ?? []) {
    const e = r?.emoji;
    if (!e?.id || !e.name) continue;
    pushOrMerge(refs, {
      id: e.id,
      name: e.name,
      animated: typeof e.animated === "boolean" ? e.animated : null,
    });
  }

  collectFromContent(message.content, refs);
  collectFromContent(message.referenced_message?.content, refs);
  collectFromContent(message.referencedMessage?.content, refs);
  for (const snap of message.message_snapshots ?? []) {
    collectFromContent(snap?.message?.content, refs);
  }
  for (const snap of message.snapshots ?? []) {
    collectFromContent(snap?.message?.content, refs);
  }

  return Array.from(refs.values());
}
