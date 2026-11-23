/**
 * Call recordings importer.
 *
 * Reads one Cube ACR recording (`.amr`) from an inbox directory and writes one
 * `call-recordings` event for it. The app, start and contact text come from
 * the file name (`filename.ts`), the length from the AMR frames (`amr.ts`).
 * The original audio and, where it can be made, a copy browsers play are
 * stored as the event's attachments in Timeline's media store.
 *
 * Who a call was with comes from Timeline, never from the recorder: a
 * recording whose name holds a number is that number's `phone` identity; one
 * without is imported only when it overlaps exactly one call event from
 * another source, and takes that call's people and title. Until then it waits
 * in the inbox, and is tried again on later runs. The contact text stays in
 * raw_data as a hint.
 */
import type { Database } from "../../db/sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { formatIdentifier, upsertIdentities } from "../../db/identities";
import { onImportComplete } from "../../db/import-hooks";
import { backgroundCommand } from "../../lib/background-priority";
import { PHONE_IDENTITY_PLATFORM } from "../../lib/phone";
import { insertStoredAttachment } from "../../media/attachments";
import { computeHash, storeFile } from "../../media/storage";
import { readAmr } from "./amr";
import { parseRecordingName, START_PRECISION_S, zonedInstant } from "./filename";
import { callsDuring, recordingSpan } from "./match";
import { callRecordingsMeta } from "./meta";
import type { StoredRecording } from "./shared/recording";

export const EVENT_SOURCE = callRecordingsMeta.sources[0].id;
/** The file name says nothing of the call's direction. */
const EVENT_TYPE = "recording:unknown";
const AFCONVERT_TIMEOUT_MS = 5 * 60_000;

/** A copy of the audio that browsers play. */
export interface PlayableCopy {
  bytes: Uint8Array;
  extension: string;
  mimeType: string;
}

/** Makes a playable copy of the AMR file at a path, or throws saying why it can't. */
export type Converter = (amrPath: string) => Promise<PlayableCopy>;

/** AAC in an `.m4a`, with macOS's built-in `afconvert`. */
export const afconvert: Converter = async (amrPath) => {
  if (process.platform !== "darwin") throw new Error("afconvert is only available on macOS");
  const dir = await mkdtemp(join(tmpdir(), "timeline-call-recording-"));
  try {
    const out = join(dir, "playable.m4a");
    const proc = Bun.spawn(backgroundCommand(["afconvert", "-f", "m4af", "-d", "aac", amrPath, out]), {
      stdout: "ignore",
      stderr: "pipe",
      timeout: AFCONVERT_TIMEOUT_MS,
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`afconvert exited with ${proc.signalCode ?? code}: ${stderr.trim() || "no output"}`);
    return { bytes: new Uint8Array(await Bun.file(out).arrayBuffer()), extension: ".m4a", mimeType: "audio/mp4" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

export interface ImportOptions {
  sourceAccount: string;
  importBatch: string;
  /** The zone the phone wrote file-name times in. */
  timeZone: string;
  convert: Converter;
}

export type ImportOutcome =
  | { status: "imported"; eventId: number; playable: boolean }
  | { status: "duplicate"; eventId: number }
  /** Not imported yet: no Timeline call, or several, overlap a recording without a number. */
  | { status: "waiting"; reason: string };

/** Who a recording was with, as Timeline knows them. */
interface Caller {
  title: string;
  people: string[];
  /** Upserted for a number; a matched call's people already exist. */
  number: string | null;
}

function callerFor(db: Database, number: string | null, start: Date, end: Date): Caller | string {
  if (number) {
    const known = db
      .prepare(
        `SELECT COALESCE(c.display_name, i.display_name) AS name
         FROM identities i LEFT JOIN contacts c ON c.id = i.contact_id
         WHERE i.platform = ? AND i.platform_id = ?`,
      )
      .get(PHONE_IDENTITY_PLATFORM, number) as { name: string | null } | null;
    return { title: known?.name ?? number, people: [formatIdentifier(PHONE_IDENTITY_PLATFORM, number)], number };
  }
  const span = recordingSpan(start.toISOString(), end.toISOString(), START_PRECISION_S);
  const matches = span ? callsDuring(db, span) : [];
  const [match] = matches;
  if (!match) return "no Timeline call overlaps it yet";
  if (matches.length > 1) return `${matches.length} Timeline calls overlap it`;
  return { title: match.call.title ?? "Unknown caller", people: match.call.people ? (JSON.parse(match.call.people) as string[]) : [], number: null };
}

/**
 * Import the recording at `path`. Throws, leaving nothing written, when its
 * name is not a Cube name or its audio is not a whole AMR file.
 */
export async function importRecordingFile(db: Database, path: string, options: ImportOptions): Promise<ImportOutcome> {
  const file = basename(path);
  const name = parseRecordingName(file);
  if (!name) throw new Error(`${file} is not named like a Cube ACR recording (<app>_YYYYMMDD-HHMMSS_<contact>.amr); left in the inbox`);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  let amr: ReturnType<typeof readAmr>;
  try {
    amr = readAmr(bytes);
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}; left in the inbox`);
  }
  const hash = computeHash(bytes);

  // The same audio under this name or another (a re-upload or a copy) is done;
  // different audio under a name already imported is left for a person to look at.
  const sameAudio = db
    .prepare(
      `SELECT e.id FROM attachments a JOIN events e ON e.id = a.event_id
       WHERE a.source = ? AND a.content_hash = ? AND e.source_account = ? LIMIT 1`,
    )
    .get(EVENT_SOURCE, hash, options.sourceAccount) as { id: number } | null;
  if (sameAudio) return { status: "duplicate", eventId: sameAudio.id };
  const sameName = db
    .prepare("SELECT id FROM events WHERE source = ? AND source_account = ? AND source_id = ?")
    .get(EVENT_SOURCE, options.sourceAccount, file) as { id: number } | null;
  if (sameName) throw new Error(`${file}: event ${sameName.id} already holds different audio under this name; left in the inbox`);

  const start = zonedInstant(name.local, options.timeZone);
  const end = new Date(start.getTime() + amr.durationMs);
  const caller = callerFor(db, name.number, start, end);
  if (typeof caller === "string") return { status: "waiting", reason: caller };

  let playable: PlayableCopy | null = null;
  let unplayableReason: string | null = null;
  try {
    playable = await options.convert(path);
  } catch (error) {
    unplayableReason = error instanceof Error ? error.message : String(error);
    console.warn(`call-recordings: ${file} imported without a copy browsers play: ${unplayableReason}`);
  }
  const stem = file.slice(0, -".amr".length);
  // Per account, so one account's file never replaces another's under the same name.
  const folder = encodeURIComponent(options.sourceAccount);
  const original = await storeFile({ source: EVENT_SOURCE, relativePath: `${folder}/${file}`, content: bytes, hash });
  const copy = playable ? await storeFile({ source: EVENT_SOURCE, relativePath: `${folder}/${stem}${playable.extension}`, content: playable.bytes }) : null;

  const record: StoredRecording = {
    file,
    app: name.app,
    recorded_at: name.recordedAt,
    time_zone: options.timeZone,
    start_precision_s: START_PRECISION_S,
    contact: name.contact,
    number: name.number,
    codec: amr.codec,
    playable: copy !== null,
    unplayable_reason: unplayableReason,
  };
  const eventId = db.transaction(() => {
    const { id } = db
      .prepare(
        `INSERT INTO events (
           source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
           title, content, people, raw_data, import_batch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?) RETURNING id`,
      )
      .get(
        EVENT_SOURCE, file, options.sourceAccount, EVENT_TYPE, start.toISOString(), end.toISOString(), amr.durationMs,
        caller.title, JSON.stringify(caller.people), JSON.stringify(record), options.importBatch,
      ) as { id: number };
    const mimeType = amr.codec === "AMR-WB" ? "audio/amr-wb" : "audio/amr";
    insertStoredAttachment(db, { eventId: id, source: EVENT_SOURCE, sourceId: file, filename: file, mimeType }, original);
    if (copy && playable) {
      const copyName = `${stem}${playable.extension}`;
      insertStoredAttachment(db, { eventId: id, source: EVENT_SOURCE, sourceId: copyName, filename: copyName, mimeType: playable.mimeType }, copy);
    }
    if (caller.number) upsertIdentities(db, [{ platform: PHONE_IDENTITY_PLATFORM, platformId: caller.number }]);
    return id;
  })();
  onImportComplete(db);
  return { status: "imported", eventId, playable: copy !== null };
}
