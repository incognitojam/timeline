/**
 * Links each recording to the call it recorded, wherever that call came from:
 * the phone call log, a Facebook or Skype call, a Discord call, and so on.
 *
 * Links are resolved when read, never stored: the phone call log is imported
 * by hand and often lands after its recordings. Reading them fresh picks that
 * up without re-linking anything on sync.
 *
 * A recording with a number links to overlapping calls involving the same
 * person (the same identifier, or any identity of the same contact). One
 * without a number was imported from the one call it overlapped, and links to
 * that call while it is still the only one; see `match.ts` for the overlap rule.
 */
import { buildHiddenEventClause } from "../../db/events";
import type { QueryExecutor } from "../../db/pool";
import type { TimelineEvent } from "../../db/schema";
import { callsDuringQuery, callTypeClause, candidateRange, type OverlappingCall, overlappingCalls, type RecordingSpan, recordingSpan } from "./match";
import { EVENT_SOURCE } from "./parser";
import { readRecording } from "./shared/recording";

type RecordingEvent = Pick<TimelineEvent, "id" | "timestamp" | "end_timestamp" | "people" | "raw_data">;

interface Candidate extends OverlappingCall {
  recordingId: number;
  /** A no-number recording's one call: it was placed by it, so keeps it whatever else is nearer. */
  sole: boolean;
}

/** The identifier itself plus every identity of the contact it is linked to. */
async function samePerson(db: QueryExecutor, identifier: string): Promise<string[]> {
  const colon = identifier.indexOf(":");
  const rows = await db.query<{ identifier: string }>(
    `SELECT platform || ':' || platform_id AS identifier FROM identities
     WHERE contact_id = (
       SELECT contact_id FROM identities WHERE platform = ? AND platform_id = ? AND contact_id IS NOT NULL
     )`,
    identifier.slice(0, colon),
    identifier.slice(colon + 1),
  );
  return [...new Set([identifier, ...rows.map((row) => row.identifier)])];
}

/** Calls involving a numbered recording's caller that overlap it. Events with a hidden contact stay out. */
async function callsWithCaller(db: QueryExecutor, caller: string, span: RecordingSpan, people: Map<string, string[]>): Promise<OverlappingCall[]> {
  let identifiers = people.get(caller);
  if (!identifiers) {
    identifiers = await samePerson(db, caller);
    people.set(caller, identifiers);
  }
  const [from, to] = candidateRange(span);
  const hidden = await buildHiddenEventClause(db, "e");
  const calls = await db.query<TimelineEvent>(
    `SELECT DISTINCT e.* FROM event_people ep JOIN events e ON e.id = ep.event_id
     WHERE ep.person IN (${identifiers.map(() => "?").join(", ")})
       AND ep.timestamp >= ? AND ep.timestamp <= ? AND ep.source != ? AND ${callTypeClause("e.")} ${hidden}`,
    ...identifiers,
    from,
    to,
    EVENT_SOURCE,
  );
  return overlappingCalls(calls, span);
}

/** The one call a recording without a number overlaps, unless it involves a hidden contact; none if several. */
async function soleCall(db: QueryExecutor, span: RecordingSpan): Promise<OverlappingCall[]> {
  const { sql, params } = callsDuringQuery(span);
  const matches = overlappingCalls(await db.query<TimelineEvent>(sql, ...params), span);
  const [match] = matches;
  if (!match || matches.length !== 1) return [];
  const hidden = await buildHiddenEventClause(db, "e");
  const visible = await db.get<{ id: number }>(`SELECT e.id FROM events e WHERE e.id = ? ${hidden}`, match.call.id);
  return visible ? [match] : [];
}

async function candidatesFor(db: QueryExecutor, recording: RecordingEvent, people: Map<string, string[]>): Promise<Candidate[]> {
  const record = readRecording(recording.raw_data);
  const span = recordingSpan(String(recording.timestamp), recording.end_timestamp ? String(recording.end_timestamp) : null, record?.start_precision_s ?? 1);
  if (!record || !span) return [];
  const caller = record.number ? (JSON.parse(recording.people ?? "[]") as string[])[0] : undefined;
  const calls = caller ? await callsWithCaller(db, caller, span, people) : await soleCall(db, span);
  return calls.map((match) => ({ ...match, recordingId: recording.id, sole: !caller }));
}

/**
 * The call events each recording recorded, keyed by recording event id.
 * Recordings with no matching call are left out. A recording without a number
 * keeps the one call that placed it. Otherwise a call goes to the numbered
 * recording that started nearest to it, so back-to-back calls with one person
 * pair up; two recordings of one call can therefore both show it.
 */
export async function findCallLinks(db: QueryExecutor, recordings: readonly RecordingEvent[]): Promise<Map<number, TimelineEvent[]>> {
  const people = new Map<string, string[]>();
  const candidates: Candidate[] = [];
  for (const recording of recordings) candidates.push(...(await candidatesFor(db, recording, people)));

  const nearest = new Map<number, Candidate>();
  for (const candidate of candidates) {
    if (candidate.sole) continue;
    const current = nearest.get(candidate.call.id);
    if (!current || candidate.gap < current.gap) nearest.set(candidate.call.id, candidate);
  }
  const links = new Map<number, TimelineEvent[]>();
  for (const { call, recordingId } of [...candidates.filter((candidate) => candidate.sole), ...nearest.values()]) {
    const linked = links.get(recordingId) ?? [];
    if (linked.length === 0) links.set(recordingId, linked);
    linked.push(call);
  }
  for (const linked of links.values()) linked.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  return links;
}
