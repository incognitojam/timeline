import { resolveIdentities } from "../db/identities";
import type { QueryExecutor } from "../db/pool";
import type { TimelineEvent } from "../db/schema";
import { parseDiscordPoll } from "../shared/discord-forward";
import { extractUserMentionIds } from "../shared/discord-mentions";
import { normalizeReactions } from "../shared/reactions";

export interface RenderIdentityOptions {
  displayNames: Record<string, string>;
  discordUserResolver: (id: string) => string | null;
}

function getSenderIdentifier(people: string | null): string | null {
  if (!people) return null;
  try {
    const parsed: unknown = JSON.parse(people);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      return parsed[0];
    }
  } catch {}
  return null;
}

/** Identifiers of everyone an event's body names besides its sender. */
export function collectRenderedIdentifiers(event: TimelineEvent): string[] {
  const identifiers: string[] = [];
  if (event.source === "discord" && event.content) {
    for (const id of extractUserMentionIds(event.content)) {
      identifiers.push(`discord:${id}`);
    }
  }
  for (const reaction of normalizeReactions(event) ?? []) {
    for (const actor of reaction.actors ?? []) {
      if (actor.identifier) identifiers.push(actor.identifier);
    }
  }
  if (event.source === "discord") {
    for (const voters of parseDiscordPoll(event.raw_data)?.votersByAnswerId.values() ?? []) {
      for (const voter of voters) identifiers.push(`discord:${voter.id}`);
    }
  }
  return identifiers;
}

/** Resolve every person an export renders with one batched identity lookup. */
export async function resolveRenderIdentities(
  db: QueryExecutor,
  events: TimelineEvent[],
): Promise<RenderIdentityOptions> {
  const identifiers = new Set<string>();
  for (const event of events) {
    const sender = getSenderIdentifier(event.people);
    if (sender) identifiers.add(sender);
    for (const identifier of collectRenderedIdentifiers(event)) identifiers.add(identifier);
  }

  const resolved = identifiers.size > 0
    ? await resolveIdentities(db, [...identifiers])
    : {};
  const displayNames: Record<string, string> = {};
  for (const [identifier, identity] of Object.entries(resolved)) {
    if (identity.name) displayNames[identifier] = identity.name;
  }

  return {
    displayNames,
    discordUserResolver: (id) => resolved[`discord:${id}`]?.name ?? null,
  };
}
