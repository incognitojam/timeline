/**
 * Contacts the user marks hidden are left out of Timeline's named MCP tools,
 * with the web app's meaning of hidden: an event that event_people files under
 * a hidden contact's identity is left out (buildHiddenEventClause in
 * src/db/events.ts), so a group chat keeps everyone else's messages and a DM
 * with a hidden contact disappears. A tool asked for a hidden contact by name,
 * id or identifier gives the reply it gives for someone unknown, and nothing
 * of theirs. run_sql still reads every row: this filters the named tools, it
 * is not an access control.
 *
 * Queries that build their own SQL take the clause (or their function's
 * excludeHidden / includeHiddenContacts: false option); a tool holding events
 * fetched some other way passes them through withoutHiddenContactEvents.
 */

import type { QueryExecutor } from "../db/pool";
import { resolveIdentities } from "../db/identities";
import { hasHiddenContacts, hiddenEventIdsAmong } from "../db/queries";
import type { TimelineEvent } from "../db/schema";
import { hiddenForwardIds } from "../export/hidden-forwards";
import { parseDiscordPoll } from "../platforms/discord/shared/forward";
import { extractUserMentionIds } from "../platforms/discord/shared/mentions";

/** One line for the server instructions, so a model does not read a gap as missing data. */
export const HIDDEN_CONTACTS_NOTE = "Contacts the user has hidden, and the events filed under them, are left out of these tools.";

/**
 * What a hidden contact is called where a visible event names them (a mention,
 * a poll voter, a reaction): a name of some kind, so the renderer does not fall
 * back to the handle the event recorded.
 */
export const HIDDEN_CONTACT_NAME = "someone";

/** The events, in order, without those filed under a hidden contact. */
export async function withoutHiddenContactEvents<E extends Pick<TimelineEvent, "id">>(
  db: QueryExecutor,
  events: E[],
): Promise<E[]> {
  const hidden = await hiddenEventIdsAmong(db, events.map((e) => e.id));
  return events.filter((e) => !hidden.has(e.id));
}

/**
 * The windows, in order, without any whose snippet could show a hidden
 * contact: it quotes every message in the window as indexed, forwards
 * included, and names those it mentions and poll voters. A window whose messages are gone is
 * dropped too, since nothing then says whose they were.
 */
export async function withoutHiddenWindows<W extends { eventIds: number[] }>(
  db: QueryExecutor,
  windows: W[],
): Promise<W[]> {
  const ids = [...new Set(windows.flatMap((w) => w.eventIds))];
  if (ids.length === 0) return windows;
  const rows = await db.query<Pick<TimelineEvent, "id" | "source" | "source_account" | "raw_data" | "content">>(
    `SELECT id, source, source_account, raw_data, content FROM events WHERE id IN (${ids.map(() => "?").join(", ")})`,
    ...ids,
  );
  const present = new Set(rows.map((row) => row.id));
  if (!(await hasHiddenContacts(db))) return windows.filter((w) => w.eventIds.every((id) => present.has(id)));
  const hidden = await hiddenEventIdsAmong(db, ids);
  for (const id of await hiddenForwardIds(db, rows)) hidden.add(id);
  const named = new Map(rows.map((row) => [row.id, [
    ...extractUserMentionIds(row.content ?? ""),
    ...[...parseDiscordPoll(row.raw_data)?.votersByAnswerId.values() ?? []].flat().map((voter) => voter.id),
  ].map((id) => `discord:${id}`)]));
  const identities = await resolveIdentities(db, [...new Set([...named.values()].flat())]);
  for (const [id, people] of named) if (people.some((person) => identities[person]?.hidden)) hidden.add(id);
  return windows.filter((w) => w.eventIds.every((id) => present.has(id) && !hidden.has(id)));
}

/** The ids of hidden contacts, for leaving out what is linked to them (memory notes). */
export async function hiddenContactIds(db: QueryExecutor): Promise<Set<number>> {
  return new Set((await db.query<{ id: number }>("SELECT id FROM contacts WHERE hidden = 1")).map((row) => row.id));
}
