import {
  DEFAULT_DISCORD_TIMESTAMP_STYLE,
  type DiscordTimestampStyle,
  formatDiscordTimestampPlain,
  isRenderableDiscordTimestamp,
} from "./discord-timestamps";

export type DiscordSegment =
  | { kind: "text"; value: string }
  | { kind: "user-mention"; id: string; name: string }
  | { kind: "channel-mention"; id: string; name: string }
  | { kind: "role-mention"; id: string; name?: string }
  | { kind: "custom-emoji"; id: string; name: string; animated: boolean }
  | { kind: "timestamp"; seconds: number; style: DiscordTimestampStyle };

interface MentionUser {
  id: string;
  name?: string;
  username?: string;
  global_name?: string;
}

interface MentionChannel {
  id: string;
  name?: string;
}

interface MentionRole {
  id: string;
  name?: string;
}

function parseRaw(rawData: unknown): {
  users: Map<string, string>;
  channels: Map<string, string>;
  roles: Map<string, string>;
} {
  const users = new Map<string, string>();
  const channels = new Map<string, string>();
  const roles = new Map<string, string>();

  let parsed: unknown = rawData;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { users, channels, roles };
  }
  const raw = parsed as {
    mentions?: MentionUser[];
    mention_channels?: MentionChannel[];
    mention_roles?: Array<string | MentionRole>;
  };

  for (const u of raw.mentions ?? []) {
    if (!u?.id) continue;
    const name = u.name || u.global_name || u.username;
    if (name) users.set(u.id, name);
  }
  for (const c of raw.mention_channels ?? []) {
    if (!c?.id) continue;
    if (c.name) channels.set(c.id, c.name);
  }
  for (const r of raw.mention_roles ?? []) {
    if (typeof r === "string") continue;
    if (!r?.id) continue;
    if (r.name) roles.set(r.id, r.name);
  }

  return { users, channels, roles };
}

function shortId(id: string): string {
  return id.length > 6 ? `${id.slice(0, 4)}…` : id;
}

// Matches Discord mention tokens. Anchored alternatives in priority order so we
// can advance the cursor by the matched length and emit the right segment kind.
//   <@123>, <@!123>     — user (! marker is the legacy nickname form)
//   <#123>              — channel
//   <@&123>             — role
//   <:name:123>         — custom emoji
//   <a:name:123>        — animated custom emoji
//   <t:123>, <t:123:R>  — timestamp, with an optional style suffix
const TOKEN_RE = /<(?:(@!?|@&|#|a?:[a-zA-Z0-9_]+:)(\d+)|t:(-?\d+)(?::([tTdDfFR]))?)>/g;

export interface MentionResolvers {
  /** Resolve a Discord user id to a display name. Tried before the name in raw_data. */
  user?: (id: string) => string | null | undefined;
}

export function parseDiscordMentions(
  content: string,
  rawData: unknown,
  resolvers?: MentionResolvers
): DiscordSegment[] {
  if (!content) return [];
  const { users, channels, roles } = parseRaw(rawData);
  const segments: DiscordSegment[] = [];

  let cursor = 0;
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = TOKEN_RE.exec(content);
  while (match !== null) {
    const start = match.index;
    if (start > cursor) {
      segments.push({ kind: "text", value: content.slice(cursor, start) });
    }
    const prefix = match[1];
    const id = match[2];
    const timestampSeconds = match[3];

    if (timestampSeconds !== undefined) {
      const seconds = Number(timestampSeconds);
      const style = (match[4] as DiscordTimestampStyle | undefined) ??
        DEFAULT_DISCORD_TIMESTAMP_STYLE;
      // Discord shows an out-of-range token as literal text; so do we.
      if (isRenderableDiscordTimestamp(seconds)) {
        segments.push({ kind: "timestamp", seconds, style });
      } else {
        segments.push({ kind: "text", value: match[0] });
      }
    } else if (prefix === "@" || prefix === "@!") {
      const resolved = resolvers?.user?.(id) || undefined;
      const name = resolved ?? users.get(id) ?? `user:${shortId(id)}`;
      segments.push({ kind: "user-mention", id, name });
    } else if (prefix === "#") {
      const name = channels.get(id) ?? `channel:${shortId(id)}`;
      segments.push({ kind: "channel-mention", id, name });
    } else if (prefix === "@&") {
      const name = roles.get(id);
      segments.push({ kind: "role-mention", id, name });
    } else {
      // emoji prefix: ":name:" or "a:name:"
      const animated = prefix.startsWith("a:");
      const emojiName = prefix.slice(animated ? 2 : 1, -1);
      segments.push({ kind: "custom-emoji", id, name: emojiName, animated });
    }

    cursor = start + match[0].length;
    match = TOKEN_RE.exec(content);
  }

  if (cursor < content.length) {
    segments.push({ kind: "text", value: content.slice(cursor) });
  }

  return segments;
}

/**
 * Extract just the user-mention IDs from `content`. Useful when batch-resolving
 * mentions across many messages before rendering — avoids a one-off regex that
 * would drift from the parser.
 */
export function extractUserMentionIds(content: string): string[] {
  if (!content) return [];
  const ids: string[] = [];
  for (const seg of parseDiscordMentions(content, null)) {
    if (seg.kind === "user-mention") ids.push(seg.id);
  }
  return ids;
}

export interface CustomEmojiRef {
  id: string;
  name: string;
  animated: boolean;
}

/**
 * Extract custom emoji refs from message content. Dedupes by id within the
 * input. The `animated` flag here is authoritative because it comes from the
 * `<a:` prefix — useful for upgrading reaction entries that lost the flag.
 */
export function extractCustomEmojiRefs(content: string): CustomEmojiRef[] {
  if (!content) return [];
  const seen = new Map<string, CustomEmojiRef>();
  for (const seg of parseDiscordMentions(content, null)) {
    if (seg.kind !== "custom-emoji") continue;
    const existing = seen.get(seg.id);
    if (!existing) {
      seen.set(seg.id, { id: seg.id, name: seg.name, animated: seg.animated });
    } else if (seg.animated && !existing.animated) {
      existing.animated = true;
    }
  }
  return Array.from(seen.values());
}

export interface PlainTextOptions {
  /** IANA zone for inline `<t:…>` timestamps. Defaults to UTC. */
  timeZone?: string;
}

export function discordMentionsToPlainText(
  content: string,
  rawData: unknown,
  resolvers?: MentionResolvers,
  options?: PlainTextOptions
): string {
  const segments = parseDiscordMentions(content, rawData, resolvers);
  if (segments.length === 0) return content;
  let out = "";
  for (const seg of segments) {
    switch (seg.kind) {
      case "text":
        out += seg.value;
        break;
      case "user-mention":
        out += `@${seg.name}`;
        break;
      case "channel-mention":
        out += `#${seg.name}`;
        break;
      case "role-mention":
        out += seg.name ? `@${seg.name}` : `@role:${shortId(seg.id)}`;
        break;
      case "custom-emoji":
        out += `:${seg.name}:`;
        break;
      case "timestamp":
        out += formatDiscordTimestampPlain(seg.seconds, seg.style, options?.timeZone);
        break;
    }
  }
  return out;
}
