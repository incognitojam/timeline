/**
 * get_schema's overview: what a model needs to write correct SQL for run_sql,
 * with recipes that schema.test.ts runs.
 */

import { conversationTypeClause } from "../db/conversation-types";
import type { SourceStats } from "../db/queries";

// A message's sender is people[0]; split it to look identities up by their key.
const SENDER = `json_extract(e.people, '$[0]')`;

/** Worked queries shown in the overview, each run by schema.test.ts. */
export const SCHEMA_RECIPES = [
  {
    label: "Keyword search (a column filter, MATCH 'content: hike', also works)",
    sql: `SELECT e.id, e.timestamp, e.source, e.title FROM events_fts f JOIN events e ON e.id = f.rowid WHERE events_fts MATCH '"mount si"' ORDER BY e.timestamp DESC LIMIT 20`,
  },
  {
    label: "Chat events contact 2 is in, group chats included (bound the time: this reads each row's people)",
    sql: `SELECT e.id, e.timestamp, e.source, e.content FROM events e WHERE e.timestamp >= '2026-10-01' AND e.timestamp < '2026-11-01' AND ${conversationTypeClause("e.")} AND EXISTS (SELECT 1 FROM json_each(e.people) p JOIN identities i ON p.value = i.platform||':'||i.platform_id WHERE i.contact_id = 2) ORDER BY e.timestamp LIMIT 100`,
  },
  {
    label: "Who sent each message, and whether it was the user (the phone importer lists the other person first on texts not yet sent, such as sms:failed)",
    sql: `SELECT e.id, e.timestamp, e.title AS chat, coalesce(c.display_name, i.display_name, ${SENDER}) AS sender, coalesce(c.is_self, 0) AS is_self, e.content FROM events e LEFT JOIN identities i ON i.platform = substr(${SENDER}, 1, instr(${SENDER}, ':') - 1) AND i.platform_id = substr(${SENDER}, instr(${SENDER}, ':') + 1) LEFT JOIN contacts c ON c.id = i.contact_id WHERE e.source = 'discord' AND e.timestamp >= '2026-10-01' AND e.type LIKE 'message%' ORDER BY e.timestamp LIMIT 50`,
  },
  {
    label: "Top Spotify artists",
    sql: `SELECT substr(t.value, 8) AS artist, count(*) AS plays FROM events e, json_each(e.tags) t WHERE e.source = 'spotify' AND e.type = 'listen:track' AND e.timestamp >= '2026-10-01' AND t.value LIKE 'artist:%' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`,
  },
] as const;

/** get_schema with no source. */
export function renderSchemaOverview(sources: SourceStats[], latest: Map<string, string | null>): string {
  const totals = new Map<string, number>();
  for (const s of sources) totals.set(s.source, (totals.get(s.source) ?? 0) + s.count);
  const catalog = [...totals]
    .sort((a, b) => b[1] - a[1])
    .map(([source, n]) => `${source} ${n} ${latest.get(source)?.slice(0, 10) ?? "undated"}`)
    .join(", ");
  return [
    "SQLite. Timestamps are UTC ISO 8601 text; daily records (health, card transactions) sit at T00:00:00Z; a few keep a local offset (google-health sleep: ...-08:00). For a UTC day across sources, bound timestamp a day wide either side, then test date(timestamp) = '2026-10-05'.",
    "",
    "events: id, source, source_account, type, timestamp, end_timestamp, duration_ms, title, content, people, tags, location_name, latitude, longitude, conversation_id, raw_data (large JSON: json_extract; get_schema(source) lists types and paths)",
    `- A chat event: ${conversationTypeClause()}. Add type NOT LIKE 'call:%' for messages only; it also matches AI-assistant sessions (claude-code:message:user), so filter source too.`,
    "- (source, source_account, conversation_id) is one chat; conversation_id is set only on chat events, and title usually names the chat (for a DM, the other person).",
    "- people: JSON array of \"platform:id\"; a message lists its sender first. tags: JSON array; Spotify adds \"artist:<name>\" and \"album:<name>\".",
    "- Full text on title, content, location_name: events_fts (words as written, \"phrases\", prefix*) and events_fts_stemmed (English stems, single words; what query_events uses).",
    "",
    "contacts(id, display_name, notes, hidden, date_of_birth, is_self); identities(contact_id, platform, platform_id, display_name, username) map people's \"platform:id\" to contacts. A name LIKE on people also matches that person's Spotify listens (spotify:<user>) and misses ids such as phone numbers: join identities.",
    "event_people(event_id, person, timestamp, is_sender) indexes events by person (\"platform:id\"); a group message is filed under its sender only. Fast for what a contact sent.",
    "contact_memories(contact_id, content, created_at): facts saved about contacts.",
    "",
    ...SCHEMA_RECIPES.flatMap((r) => [`${r.label}:`, `  ${r.sql}`]),
    "",
    `Sources (event count, latest date): ${catalog}`,
  ].join("\n");
}
