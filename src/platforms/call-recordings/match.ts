/**
 * Which Timeline call events a recording overlaps in time, from any source:
 * the phone call log, Facebook, Skype and Discord calls, and so on.
 *
 * A recording without a number takes its caller from the one call it
 * overlaps, so the overlap rule here decides who it was with. The window
 * allows for the recorder's start precision and for ringing: the call log
 * starts a call when it is dialled, the recorder when it connects.
 */
import type { Database } from "bun:sqlite";
import type { TimelineEvent } from "../../db/schema";
import { DECLARED_SOURCES } from "../../shared/sources";
import { getDiscordCallDetails } from "../discord/shared/call";
import { callRecordingsMeta } from "./meta";

const RECORDING_SOURCE = callRecordingsMeta.sources[0].id;
/** How long a call may ring before it connects and the recorder starts. */
export const RING_SLACK_MS = 60_000;
/** The furthest a call's start may sit before its recording's (a recorder started late into a call). */
export const MAX_LEAD_MS = 6 * 60 * 60 * 1000;
/**
 * Stored timestamps are ISO strings that may carry any UTC offset, so the
 * indexed text range is widened by the largest one; overlap is then checked
 * on parsed instants.
 */
const MAX_OFFSET_MS = 14 * 60 * 60 * 1000;

/** Call events from any source: `call:*` (phone, Skype logs) and `…:call` messages (Facebook, Skype, Discord). */
export function isCallEventType(type: string): boolean {
  return type.startsWith("call:") || type.endsWith(":call");
}

/** `isCallEventType` as SQL on `events.type`, so ordinary messages are never loaded. */
export function callTypeClause(alias = ""): string {
  return `(${alias}type LIKE 'call:%' OR ${alias}type LIKE '%:call')`;
}

/** Sources that declare call event types; only their events can be calls. */
export const CALL_SOURCES: readonly string[] = DECLARED_SOURCES.filter((source) =>
  (source.eventTypes ?? []).some(isCallEventType),
).map((source) => source.id);

/** A recording's time, padded by what the recorder may have missed at either end. */
export interface RecordingSpan {
  start: number;
  end: number;
  pad: number;
}

export function recordingSpan(start: string, end: string | null, precisionS: number): RecordingSpan | null {
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return null;
  const endMs = end ? Date.parse(end) : startMs;
  return { start: startMs, end: Number.isNaN(endMs) ? startMs : endMs, pad: precisionS * 1000 + RING_SLACK_MS };
}

/** Text bounds on `timestamp` that hold every call that could overlap the span. */
export function candidateRange(span: RecordingSpan): [string, string] {
  return [
    new Date(span.start - span.pad - MAX_LEAD_MS - MAX_OFFSET_MS).toISOString(),
    new Date(span.end + span.pad + MAX_OFFSET_MS).toISOString(),
  ];
}

/**
 * When a call ran, or null for one that never connected. Discord keeps its
 * call's length and who joined in raw_data rather than the duration column.
 */
function callInterval(call: TimelineEvent): [number, number] | null {
  const start = Date.parse(String(call.timestamp));
  if (Number.isNaN(start) || call.duration_ms === 0) return null;
  const discord = getDiscordCallDetails(call);
  if (discord?.participation === "missed") return null;
  const durationMs = call.duration_ms ?? discord?.durationMs ?? 0;
  const end = call.end_timestamp ? Date.parse(String(call.end_timestamp)) : start + durationMs;
  return [start, Number.isNaN(end) ? start : end];
}

export interface OverlappingCall {
  call: TimelineEvent;
  /** How far the call's start is from the recording's. */
  gap: number;
}

/** The connected call events among `events` that overlap the span. */
export function overlappingCalls(events: readonly TimelineEvent[], span: RecordingSpan): OverlappingCall[] {
  return events.flatMap((call) => {
    if (call.source === RECORDING_SOURCE || !isCallEventType(call.type)) return [];
    const interval = callInterval(call);
    if (!interval || interval[0] > span.end + span.pad || interval[1] < span.start - span.pad) return [];
    return [{ call, gap: Math.abs(interval[0] - span.start) }];
  });
}

/** The query for call events from any source that could overlap the span; filter its rows with `overlappingCalls`. */
export function callsDuringQuery(span: RecordingSpan): { sql: string; params: string[] } {
  const [from, to] = candidateRange(span);
  return {
    sql: `SELECT * FROM events WHERE source IN (${CALL_SOURCES.map(() => "?").join(", ")})
          AND timestamp >= ? AND timestamp <= ? AND ${callTypeClause()}`,
    params: [...CALL_SOURCES, from, to],
  };
}

/** Every connected call event from any source that overlaps the span. */
export function callsDuring(db: Database, span: RecordingSpan): OverlappingCall[] {
  const { sql, params } = callsDuringQuery(span);
  return overlappingCalls(db.prepare(sql).all(...params) as TimelineEvent[], span);
}
