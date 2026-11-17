/**
 * Call recordings importer.
 *
 * Reads the JSON that call-transcribe's `calls list` prints and writes one
 * `call-recordings` event per recording. call-transcribe owns the audio and
 * the transcripts: the best transcript's `.txt` becomes the event's content,
 * and the audio stays where `calls` reports it.
 *
 * A record is keyed by its `id` (the file name) and changes are detected by
 * its `fingerprint`, so a transcript added or edited later rewrites the event
 * in place. A record whose id is new but whose audio `sha1` matches a stored
 * event is the same recording renamed, and takes over that event.
 *
 * Who a call was with comes from Timeline, never from `calls`: a recording
 * with a number is that number's `phone` identity; one without is imported
 * only when it overlaps exactly one call event from another source, and takes
 * that call's people and title. Its `contact` name stays in raw_data as a hint.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { formatIdentifier, upsertIdentities, type UpsertIdentityOptions } from "../../db/identities";
import { onImportComplete } from "../../db/import-hooks";
import { normalizePhoneNumber, PHONE_IDENTITY_PLATFORM } from "../../lib/phone";
import { callsDuring, recordingSpan } from "./match";
import { callRecordingsMeta } from "./meta";
import type { CallsRecording, CallsTranscript } from "./shared/recording";

export const EVENT_SOURCE = callRecordingsMeta.sources[0].id;
/** The only `calls` schema this importer understands; a new version changes or removes fields. */
export const SCHEMA_VERSION = 1;
/** Bounds that keep a record's times sane; anything past them is a broken record. */
const MAX_PRECISION_S = 24 * 60 * 60;
const MAX_DURATION_S = 7 * 24 * 60 * 60;

export interface CallsListing {
  schema_version: typeof SCHEMA_VERSION;
  count: number;
  recordings: CallsRecording[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(where: string, message: string): never {
  throw new Error(`calls ${where}: ${message}`);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") fail(where, `"${key}" must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, where: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(where, `"${key}" must be a string or null`);
  return value === "" ? null : value;
}

function requireSeconds(record: Record<string, unknown>, key: string, max: number, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    fail(where, `"${key}" must be a number of seconds from 0 to ${max}`);
  }
  return value;
}

function requireTime(record: Record<string, unknown>, key: string, where: string): string {
  const value = requireString(record, key, where);
  if (Number.isNaN(Date.parse(value))) fail(where, `"${key}" is not a timestamp: ${value}`);
  return value;
}

function validateTranscript(value: unknown, where: string): CallsTranscript {
  if (!isRecord(value)) fail(where, "transcript is not an object");
  requireString(value, "kind", where);
  requireString(value, "txt", where);
  return value as unknown as CallsTranscript;
}

function validateRecording(value: unknown, index: number): CallsRecording {
  if (!isRecord(value)) fail(`recording ${index}`, "is not an object");
  const where = `recording ${typeof value.id === "string" ? value.id : index}`;
  requireString(value, "id", where);
  requireString(value, "sha1", where);
  requireString(value, "source", where);
  const start = Date.parse(requireTime(value, "start", where));
  const end = Date.parse(requireTime(value, "end", where));
  if (end < start) fail(where, "ends before it starts");
  requireSeconds(value, "start_precision_s", MAX_PRECISION_S, where);
  requireSeconds(value, "duration_s", MAX_DURATION_S, where);
  const direction = value.direction;
  if (direction !== null && direction !== "incoming" && direction !== "outgoing") {
    fail(where, `unknown direction ${JSON.stringify(direction)}`);
  }
  const number = optionalString(value, "number", where);
  const contact = optionalString(value, "contact", where);
  if (typeof value.caller_unknown !== "boolean") fail(where, `"caller_unknown" must be a boolean`);
  if (value.caller_unknown !== (number === null && contact === null)) {
    fail(where, `"caller_unknown" is ${value.caller_unknown} but number and contact say otherwise`);
  }
  requireString(value, "recorded_sides", where);
  if (!isRecord(value.audio)) fail(where, `"audio" must be an object`);
  requireString(value.audio, "original", where);
  if (!Array.isArray(value.transcripts)) fail(where, `"transcripts" must be an array`);
  for (const transcript of value.transcripts) validateTranscript(transcript, where);
  optionalString(value, "best_transcript", where);
  requireString(value, "fingerprint", where);
  return value as unknown as CallsRecording;
}

/** Validate `calls list` output at the boundary; anything unexpected fails the import. */
export function parseListing(stdout: string): CallsListing {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`calls list printed invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) fail("list", "output is not an object");
  if (value.schema_version !== SCHEMA_VERSION) {
    fail("list", `schema_version ${JSON.stringify(value.schema_version)} is not supported (Timeline reads ${SCHEMA_VERSION})`);
  }
  if (!Array.isArray(value.recordings)) fail("list", `"recordings" must be an array`);
  if (value.count !== value.recordings.length) {
    fail("list", `count ${JSON.stringify(value.count)} does not match ${value.recordings.length} recordings`);
  }
  const recordings = value.recordings.map(validateRecording);
  for (const key of ["id", "sha1"] as const) {
    const seen = new Set<string>();
    for (const recording of recordings) {
      if (seen.has(recording[key])) fail("list", `two recordings share ${key} ${recording[key]}`);
      seen.add(recording[key]);
    }
  }
  return { schema_version: SCHEMA_VERSION, count: recordings.length, recordings };
}

/** Event type from the call's direction. */
export function eventTypeFor(recording: CallsRecording): string {
  return `recording:${recording.direction ?? "unknown"}`;
}

/** The `phone` identity of a recording's number, the same one the call log and messages use. */
export function numberIdentity(recording: CallsRecording): UpsertIdentityOptions | null {
  if (!recording.number) return null;
  return { platform: PHONE_IDENTITY_PLATFORM, platformId: normalizePhoneNumber(recording.number) };
}

export interface ImportOptions {
  sourceAccount: string;
  importBatch: string;
}

export interface ImportStats {
  recordings: number;
  imported: number;
  /** Stored events rewritten because the record's fingerprint changed. */
  updated: number;
  /** Stored events taken over by a renamed recording (same sha1, new id). */
  renamed: number;
  unchanged: number;
  withTranscript: number;
  withoutTranscript: number;
  identities: number;
  /** Recordings without a number left out because no Timeline call overlaps them yet. */
  skippedNoCall: number;
  /** Recordings without a number left out because several Timeline calls overlap them. */
  skippedAmbiguous: number;
  /** Stored recordings whose record changed but no longer match one call: kept with the caller they had. */
  keptCaller: number;
}

function readTranscript(recording: CallsRecording): string | null {
  if (!recording.best_transcript) return null;
  let text: string;
  try {
    text = readFileSync(recording.best_transcript, "utf8");
  } catch (error) {
    throw new Error(`Recording ${recording.id}: cannot read its transcript: ${error instanceof Error ? error.message : String(error)}`);
  }
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

interface StoredEvent {
  id: number;
  source_id: string;
  fingerprint: string | null;
  title: string | null;
  people: string | null;
}

/** Who a recording was with, as Timeline knows them. */
interface Caller {
  title: string;
  people: string[];
  /** Upserted for a number; a matched call's people already exist. */
  identity: UpsertIdentityOptions | null;
}

export function importCallRecordings(db: Database, listing: CallsListing, options: ImportOptions): ImportStats {
  const stats: ImportStats = {
    recordings: listing.recordings.length,
    imported: 0,
    updated: 0,
    renamed: 0,
    unchanged: 0,
    withTranscript: 0,
    withoutTranscript: 0,
    identities: 0,
    skippedNoCall: 0,
    skippedAmbiguous: 0,
    keptCaller: 0,
  };
  const stored = `id, source_id, json_extract(raw_data, '$.fingerprint') AS fingerprint, title, people`;
  const findById = db.prepare(`SELECT ${stored} FROM events WHERE source = ? AND source_id = ? AND source_account = ?`);
  const findBySha1 = db.prepare(
    `SELECT ${stored} FROM events WHERE source = ? AND source_account = ? AND json_extract(raw_data, '$.sha1') = ?`,
  );
  const knownName = db.prepare(`
    SELECT COALESCE(c.display_name, i.display_name) AS name
    FROM identities i LEFT JOIN contacts c ON c.id = i.contact_id
    WHERE i.platform = ? AND i.platform_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, people, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE events SET
      source_id = ?, type = ?, timestamp = ?, end_timestamp = ?, duration_ms = ?,
      title = ?, content = ?, people = ?, raw_data = ?, import_batch = ?
    WHERE id = ?
  `);
  const identities = new Map<string, UpsertIdentityOptions>();
  const remember = (identity: UpsertIdentityOptions | null) => {
    if (identity) identities.set(formatIdentifier(identity.platform, identity.platformId), identity);
  };

  /**
   * The caller for a new or changed record, or null to leave it out. A record
   * without a number that no longer matches one call keeps the caller its
   * stored event already has: a call-log row reimported or a second overlapping
   * call must not take a recording's caller away, let alone the recording.
   */
  const callerFor = (recording: CallsRecording, existing: StoredEvent | null): Caller | null => {
    const identity = numberIdentity(recording);
    if (identity) {
      const known = knownName.get(identity.platform, identity.platformId) as { name: string | null } | null;
      return { title: known?.name ?? identity.platformId, people: [formatIdentifier(identity.platform, identity.platformId)], identity };
    }
    const span = recordingSpan(recording.start, recording.end, recording.start_precision_s);
    const matches = span ? callsDuring(db, span) : [];
    const [match] = matches;
    if (match && matches.length === 1) {
      const people = match.call.people ? (JSON.parse(match.call.people) as string[]) : [];
      return { title: match.call.title ?? "Unknown caller", people, identity: null };
    }
    if (existing) {
      stats.keptCaller++;
      return { title: existing.title ?? "Unknown caller", people: existing.people ? (JSON.parse(existing.people) as string[]) : [], identity: null };
    }
    if (matches.length === 0) stats.skippedNoCall++;
    else stats.skippedAmbiguous++;
    return null;
  };

  const write = (recording: CallsRecording, existing: StoredEvent | null, caller: Caller): void => {
    remember(caller.identity);
    const content = readTranscript(recording);
    if (content === null) stats.withoutTranscript++;
    else stats.withTranscript++;
    const values = [
      eventTypeFor(recording),
      new Date(recording.start).toISOString(),
      new Date(recording.end).toISOString(),
      Math.round(recording.duration_s * 1000),
      caller.title,
      content,
      JSON.stringify(caller.people),
      JSON.stringify(recording),
      options.importBatch,
    ] as const;
    if (existing) update.run(recording.id, ...values, existing.id);
    else insert.run(EVENT_SOURCE, recording.id, options.sourceAccount, ...values);
  };

  db.transaction(() => {
    for (const recording of listing.recordings) {
      const byId = findById.get(EVENT_SOURCE, recording.id, options.sourceAccount) as StoredEvent | null;
      if (byId && byId.fingerprint === recording.fingerprint) {
        stats.unchanged++;
        remember(numberIdentity(recording));
        continue;
      }
      const existing = byId ?? (findBySha1.get(EVENT_SOURCE, options.sourceAccount, recording.sha1) as StoredEvent | null);
      const caller = callerFor(recording, existing);
      if (!caller) continue;
      write(recording, existing, caller);
      if (byId) stats.updated++;
      else if (existing) stats.renamed++;
      else stats.imported++;
    }
    if (identities.size > 0) upsertIdentities(db, [...identities.values()]);
  })();

  stats.identities = identities.size;
  onImportComplete(db);
  return stats;
}
