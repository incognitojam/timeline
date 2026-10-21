import { isRecord } from "./guards";

export interface DiscordCustomReactionEmoji {
  id: string;
  name: string;
  animated: boolean;
}

export interface ReactionActor {
  /** `people[]` identifier ("discord:<id>", "facebook:name:<name>"), or null when the payload has no id. */
  identifier: string | null;
  /** The name captured with the reaction, which may predate the actor's current identity. */
  name: string;
}

export interface NormalizedReaction {
  emoji: string;
  count: number;
  actors?: ReactionActor[];
  /** Discord server emoji metadata used by the web UI to render /api/discord/emoji/{id}. */
  custom?: DiscordCustomReactionEmoji;
}

export interface ReactionEvent {
  source: string;
  raw_data?: string | null;
}

const DEFAULT_FACEBOOK_REACTION = "👍";

function parseRawData(rawData: string | null | undefined): Record<string, unknown> | null {
  if (!rawData) return null;
  try {
    const parsed: unknown = JSON.parse(rawData);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function discordActors(users: unknown): ReactionActor[] | undefined {
  if (!Array.isArray(users)) return undefined;

  const actors: ReactionActor[] = [];
  for (const user of users) {
    if (!isRecord(user)) continue;
    if (typeof user.name !== "string") continue;
    actors.push({
      identifier: typeof user.id === "string" && user.id.length > 0 ? `discord:${user.id}` : null,
      name: user.name,
    });
  }

  return actors.length > 0 ? actors : undefined;
}

function normalizeDiscordReactions(rawReactions: unknown[]): NormalizedReaction[] {
  const reactions: NormalizedReaction[] = [];

  for (const rawReaction of rawReactions) {
    if (!isRecord(rawReaction) || !isRecord(rawReaction.emoji)) continue;

    const name = rawReaction.emoji.name;
    const count = rawReaction.count;
    if (typeof name !== "string" || typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      continue;
    }

    const id = rawReaction.emoji.id;
    const reaction: NormalizedReaction = { emoji: name, count };
    const actors = discordActors(rawReaction.users);
    if (actors) reaction.actors = actors;
    if (typeof id === "string" && id.length > 0) {
      reaction.custom = { id, name, animated: rawReaction.emoji.animated === true };
    }
    reactions.push(reaction);
  }

  return reactions;
}

function normalizeFacebookReactions(rawReactions: unknown[]): NormalizedReaction[] {
  const grouped = new Map<string, { count: number; actors: ReactionActor[] }>();

  for (const rawReaction of rawReactions) {
    if (!isRecord(rawReaction)) continue;

    const emoji =
      typeof rawReaction.reaction === "string" && rawReaction.reaction.length > 0
        ? rawReaction.reaction
        : DEFAULT_FACEBOOK_REACTION;
    let group = grouped.get(emoji);
    if (!group) {
      group = { count: 0, actors: [] };
      grouped.set(emoji, group);
    }

    group.count += 1;
    if (typeof rawReaction.actor === "string") {
      group.actors.push({ identifier: `facebook:name:${rawReaction.actor}`, name: rawReaction.actor });
    }
  }

  return Array.from(grouped.entries()).map(([emoji, group]) => {
    const reaction: NormalizedReaction = { emoji, count: group.count };
    if (group.actors.length > 0) reaction.actors = group.actors;
    return reaction;
  });
}

export function normalizeReactions(event: ReactionEvent): NormalizedReaction[] | null {
  const raw = parseRawData(event.raw_data);
  if (!raw) return null;

  const rawReactions = raw.reactions;
  if (!Array.isArray(rawReactions) || rawReactions.length === 0) return null;

  let reactions: NormalizedReaction[];
  if (event.source === "discord") {
    reactions = normalizeDiscordReactions(rawReactions);
  } else if (event.source === "facebook") {
    reactions = normalizeFacebookReactions(rawReactions);
  } else {
    return null;
  }

  return reactions.length > 0 ? reactions : null;
}
