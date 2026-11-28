/**
 * Contacts the user marks hidden are hidden from their own day-to-day view,
 * not from agents. So the named MCP tools leave hidden contacts out of what an
 * agent is shown unprompted (catch-ups, searches, lists), with the web app's
 * meaning of hidden: an event that event_people files under a hidden contact's
 * identity is left out (buildHiddenEventClause in src/db/events.ts), so a group
 * chat keeps everyone else's messages and a DM with a hidden contact
 * disappears. What a visible message says, quotes or forwards is shown as it
 * is, with real names. Naming a hidden contact includes them: a tool given one
 * by name, id or identifier, one conversation by id, or one of their events by
 * id answers as for anyone else.
 *
 * Queries that build their own SQL take the clause (or their function's
 * excludeHidden / includeHiddenContacts: false option); a tool holding events
 * fetched some other way passes them through withoutHiddenContactEvents.
 */

import type { QueryExecutor } from "../db/pool";
import { hiddenEventIdsAmong } from "../db/queries";
import type { TimelineEvent } from "../db/schema";

/** For the server instructions: hidden contacts are not missing, and are not for an agent to volunteer. */
export const HIDDEN_CONTACTS_NOTE = "Contacts the user has hidden are left out of catch-ups, searches and lists; name one and the tools include them. Bring one up only when the conversation is about them.";

/** The events, in order, without those filed under a hidden contact. */
export async function withoutHiddenContactEvents<E extends Pick<TimelineEvent, "id">>(
  db: QueryExecutor,
  events: E[],
): Promise<E[]> {
  const hidden = await hiddenEventIdsAmong(db, events.map((e) => e.id));
  return events.filter((e) => !hidden.has(e.id));
}

/**
 * The windows, in order, without any that holds a hidden contact's own
 * message, or a message since deleted, since nothing then says whose it was.
 */
export async function withoutHiddenWindows<W extends { eventIds: number[] }>(
  db: QueryExecutor,
  windows: W[],
): Promise<W[]> {
  const ids = [...new Set(windows.flatMap((w) => w.eventIds))];
  if (ids.length === 0) return windows;
  const rows = await db.query<{ id: number }>(`SELECT id FROM events WHERE id IN (${ids.map(() => "?").join(", ")})`, ...ids);
  const present = new Set(rows.map((row) => row.id));
  const hidden = await hiddenEventIdsAmong(db, ids);
  return windows.filter((w) => w.eventIds.every((id) => present.has(id) && !hidden.has(id)));
}

/** The ids of hidden contacts, for leaving out what is linked to them (memory notes). */
export async function hiddenContactIds(db: QueryExecutor): Promise<Set<number>> {
  return new Set((await db.query<{ id: number }>("SELECT id FROM contacts WHERE hidden = 1")).map((row) => row.id));
}
