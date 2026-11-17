import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initDb } from "../../db/schema";
import { renderEvent } from "../../export/render";
import type { TimelineEvent } from "../../db/schema";
import { EVENT_SOURCE, importCallRecordings, parseListing, SCHEMA_VERSION } from "./parser";
import type { CallsRecording } from "./shared/recording";
import { parseTranscript, turnInstant } from "./shared/transcript";
import { callTypeClause, isCallEventType } from "./match";

const SCRIBE_TXT = "# Call with: Alice (2 Jun 2026, 13:11)\n\n13:11 <Alice> Hello?\nIs that you?\n\n13:12 <Bob> Yes, it's me.\n";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = join(tmpdir(), `call-recordings-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function transcriptFile(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function recording(overrides: Partial<CallsRecording> = {}): CallsRecording {
  const txt = transcriptFile(`${overrides.id ?? "Call_20260602-131135"}.txt`, SCRIBE_TXT);
  const record: Omit<CallsRecording, "caller_unknown"> & Partial<CallsRecording> = {
    id: "Call_20260602-131135",
    sha1: "a".repeat(40),
    source: "phone",
    start: "2026-06-02T13:11:35+01:00",
    end: "2026-06-02T13:14:05+01:00",
    start_precision_s: 1,
    duration_s: 150.25,
    direction: "outgoing",
    number: "+447700900123",
    contact: null,
    recorded_sides: "both_expected",
    audio: { original: join(dir, "Call_20260602-131135.amr"), flac: null, levelled: null },
    transcripts: [
      { kind: "scribe-api", engine: "elevenlabs-scribe-v2", json: join(dir, "t.json"), txt, created_at: "2026-06-02T14:00:00+01:00", words: 7, speakers_labelled: true },
    ],
    best_transcript: txt,
    updated_at: "2026-06-02T14:00:00+01:00",
    fingerprint: "f1",
    ...overrides,
  };
  return { ...record, caller_unknown: record.caller_unknown ?? (!record.number && !record.contact) };
}

let nextCall = 0;
/** A call event another source imported, with its start, length and people. */
function call(start: string, durationMs: number, people: string[], title = "Alice"): number {
  nextCall++;
  return (
    db
      .prepare(
        `INSERT INTO events (source, source_id, source_account, type, timestamp, duration_ms, title, people, raw_data, conversation_id)
         VALUES ('phone', ?, 'owner', 'call:incoming', ?, ?, ?, ?, '{}', ?) RETURNING id`,
      )
      .get(`call-${nextCall}`, start, durationMs, title, JSON.stringify(people), `conv-${nextCall}`) as { id: number }
  ).id;
}

/** A WhatsApp recording 13:11:35–13:14:05 (+01:00) with only a name. */
function nameOnly(overrides: Partial<CallsRecording> = {}): CallsRecording {
  return recording({ id: "WA_1", sha1: "b".repeat(40), source: "whatsapp", number: null, contact: "Ally", direction: null, ...overrides });
}

function listing(...recordings: CallsRecording[]) {
  return parseListing(JSON.stringify({ schema_version: SCHEMA_VERSION, count: recordings.length, recordings }));
}

function run(...recordings: CallsRecording[]) {
  return importCallRecordings(db, listing(...recordings), { sourceAccount: "owner", importBatch: "test" });
}

interface Row {
  id: number;
  source_id: string;
  type: string;
  timestamp: string;
  end_timestamp: string;
  duration_ms: number;
  title: string;
  content: string | null;
  people: string;
  raw_data: string;
}

function rows(): Row[] {
  return db.prepare("SELECT * FROM events WHERE source = ? ORDER BY id").all(EVENT_SOURCE) as Row[];
}

function search(term: string): number[] {
  return (db.prepare("SELECT rowid FROM events_fts WHERE events_fts MATCH ?").all(term) as { rowid: number }[]).map((r) => r.rowid);
}

describe("call recordings importer", () => {
  it("imports a recording with its transcript, keyed by id", () => {
    const stats = run(recording());
    expect(stats).toMatchObject({ imported: 1, updated: 0, withTranscript: 1, identities: 1 });
    const [row] = rows();
    expect(row).toMatchObject({
      source_id: "Call_20260602-131135",
      type: "recording:outgoing",
      timestamp: "2026-06-02T12:11:35.000Z",
      end_timestamp: "2026-06-02T12:14:05.000Z",
      duration_ms: 150250,
      title: "+447700900123",
      content: SCRIBE_TXT.trim(),
    });
    expect(JSON.parse(row?.people ?? "")).toEqual(["phone:+447700900123"]);
    expect(JSON.parse(row?.raw_data ?? "")).toEqual(recording());
    expect(search("Hello")).toEqual([row?.id ?? -1]);
    expect(db.prepare("SELECT platform, platform_id FROM identities").all()).toEqual([{ platform: "phone", platform_id: "+447700900123" }]);
  });

  it("titles a number with the name already known for it", () => {
    db.prepare("INSERT INTO identities (platform, platform_id, display_name) VALUES ('phone', '+447700900123', 'Alice')").run();
    run(recording());
    expect(rows()[0]?.title).toBe("Alice");
  });

  it("still imports a recording with no transcript, and fills it in when one arrives", () => {
    run(recording({ transcripts: [], best_transcript: null }));
    expect(rows()[0]?.content).toBeNull();

    const again = run(recording({ transcripts: [], best_transcript: null }));
    expect(again).toMatchObject({ imported: 0, updated: 0, unchanged: 1 });

    const later = run(recording({ fingerprint: "f2" }));
    expect(later).toMatchObject({ imported: 0, updated: 1 });
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row?.content).toBe(SCRIBE_TXT.trim());
    expect(search("Hello")).toEqual([row?.id ?? -1]);
  });

  it("rewrites the event and its search index when a transcript is edited", () => {
    run(recording());
    const txt = transcriptFile("edited.txt", "13:11 <Alice> Goodbye then.\n");
    run(recording({ fingerprint: "f2", best_transcript: txt }));
    const [row] = rows();
    expect(row?.content).toBe("13:11 <Alice> Goodbye then.");
    expect(search("Hello")).toEqual([]);
    expect(search("Goodbye")).toEqual([row?.id ?? -1]);
  });

  it("keeps the stored event when nothing changed, even if the transcript file did", () => {
    const record = recording();
    run(record);
    writeFileSync(record.best_transcript ?? "", "13:11 <Alice> Changed.\n");
    expect(run(record)).toMatchObject({ unchanged: 1, updated: 0 });
    expect(rows()[0]?.content).toBe(SCRIBE_TXT.trim());
  });

  it("recognises a renamed recording by its sha1 instead of duplicating it", () => {
    run(recording());
    const before = rows()[0]?.id;
    const stats = run(recording({ id: "Call_20260602-131135_renamed", fingerprint: "f2" }));
    expect(stats).toMatchObject({ imported: 0, renamed: 1 });
    expect(rows().map((r) => [r.id, r.source_id])).toEqual([[before ?? -1, "Call_20260602-131135_renamed"]]);
  });

  it("leaves out a recording without a number until exactly one Timeline call overlaps it", () => {
    expect(run(nameOnly())).toMatchObject({ imported: 0, skippedNoCall: 1, skippedAmbiguous: 0 });
    expect(rows()).toEqual([]);

    // The call log arrives later; the next sync picks the recording up from the call.
    call("2026-06-02T12:11:20.000Z", 160_000, ["phone:+447700900999", "phone:owner"], "Alice Example");
    expect(run(nameOnly())).toMatchObject({ imported: 1, skippedNoCall: 0, identities: 0 });
    const [row] = rows();
    expect(row).toMatchObject({ type: "recording:unknown", title: "Alice Example" });
    expect(JSON.parse(row?.people ?? "")).toEqual(["phone:+447700900999", "phone:owner"]);
    // The name calls reported stays in raw_data only, and makes no identity.
    expect(JSON.parse(row?.raw_data ?? "").contact).toBe("Ally");
    expect(db.prepare("SELECT COUNT(*) AS n FROM identities").get()).toEqual({ n: 0 });
  });

  it("leaves out a recording without a number that several calls overlap", () => {
    call("2026-06-02T12:11:20.000Z", 160_000, ["phone:+447700900999", "phone:owner"]);
    call("2026-06-02T12:12:00.000Z", 60_000, ["phone:+447700900888", "phone:owner"], "Bob");
    expect(run(nameOnly())).toMatchObject({ imported: 0, skippedAmbiguous: 1 });
    expect(rows()).toEqual([]);
  });

  it("takes a caller-unknown phone recording's caller from its call-log row", () => {
    call("2026-06-02T12:11:30.000Z", 150_000, ["phone:+447700900999", "phone:owner"], "Alice Example");
    run(recording({ number: null, contact: null, direction: "incoming" }));
    const [row] = rows();
    expect(row).toMatchObject({ type: "recording:incoming", title: "Alice Example" });
    expect(JSON.parse(row?.raw_data ?? "").caller_unknown).toBe(true);
  });

  it("keeps an imported recording and its caller when its call disappears or another overlaps", () => {
    const first = call("2026-06-02T12:11:20.000Z", 160_000, ["phone:+447700900999", "phone:owner"], "Alice Example");
    run(nameOnly());
    const [imported] = rows();

    db.prepare("DELETE FROM events WHERE id = ?").run(first);
    expect(run(nameOnly())).toMatchObject({ unchanged: 1 });
    // A changed record (say, a new transcript) is still rewritten, keeping its caller.
    expect(run(nameOnly({ fingerprint: "f2" }))).toMatchObject({ updated: 1, keptCaller: 1 });
    call("2026-06-02T12:11:30.000Z", 60_000, ["phone:+447700900888", "phone:owner"], "Bob");
    call("2026-06-02T12:12:30.000Z", 60_000, ["phone:+447700900777", "phone:owner"], "Carol");
    expect(run(nameOnly({ fingerprint: "f3" }))).toMatchObject({ updated: 1, keptCaller: 1 });

    const [kept] = rows();
    expect(kept?.id).toBe(imported?.id ?? -1);
    expect(kept).toMatchObject({ title: "Alice Example", people: imported?.people ?? "" });
  });

  it("fails loudly on a transcript it cannot read", () => {
    expect(() => run(recording({ best_transcript: join(dir, "missing.txt") }))).toThrow(/cannot read its transcript/);
    expect(rows()).toEqual([]);
  });
});

describe("calls list validation", () => {
  const body = (value: unknown) => JSON.stringify(value);

  it("rejects an unknown schema version", () => {
    expect(() => parseListing(body({ schema_version: 2, count: 0, recordings: [] }))).toThrow(/schema_version 2 is not supported/);
    expect(() => parseListing(body({ count: 0, recordings: [] }))).toThrow(/schema_version undefined/);
  });

  it("rejects invalid JSON, a count that disagrees, and duplicate ids or sha1s", () => {
    expect(() => parseListing("not json")).toThrow(/invalid JSON/);
    expect(() => parseListing(body({ schema_version: 1, count: 2, recordings: [recording()] }))).toThrow(/count 2/);
    expect(() =>
      parseListing(body({ schema_version: 1, count: 2, recordings: [recording(), recording({ id: "other" })] })),
    ).toThrow(/share sha1/);
  });

  it("rejects malformed records", () => {
    const bad = (overrides: Record<string, unknown>) =>
      parseListing(body({ schema_version: 1, count: 1, recordings: [{ ...recording(), ...overrides }] }));
    expect(() => bad({ start: "yesterday" })).toThrow(/"start" is not a timestamp/);
    expect(() => bad({ direction: "sideways" })).toThrow(/unknown direction/);
    expect(() => bad({ fingerprint: undefined })).toThrow(/"fingerprint"/);
    expect(() => bad({ audio: { flac: null } })).toThrow(/"original"/);
    expect(() => bad({ end: "2026-06-02T13:00:00+01:00" })).toThrow(/ends before it starts/);
    expect(() => bad({ caller_unknown: true })).toThrow(/"caller_unknown" is true but number and contact say otherwise/);
    expect(() => bad({ caller_unknown: undefined })).toThrow(/"caller_unknown" must be a boolean/);
    expect(() => bad({ start_precision_s: 1e308 })).toThrow(/"start_precision_s" must be a number of seconds/);
    expect(() => bad({ duration_s: -1 })).toThrow(/"duration_s" must be a number of seconds/);
  });
});

describe("call recording transcripts", () => {
  it("reads Scribe turns, joining a speaker's sentences, and skips the header", () => {
    expect(parseTranscript(SCRIBE_TXT)).toEqual([
      { time: "13:11", speaker: "Alice", text: "Hello? Is that you?" },
      { time: "13:12", speaker: "Bob", text: "Yes, it's me." },
    ]);
  });

  it("reads Parakeet lines as unattributed turns with offsets", () => {
    expect(parseTranscript("[0:00:04] Hello?\n[0:01:10] Yes.\n")).toEqual([
      { time: "0:00:04", speaker: null, text: "Hello?" },
      { time: "0:01:10", speaker: null, text: "Yes." },
    ]);
  });

  it("places turn times in the recorder's offset, across midnight, and from Parakeet offsets", () => {
    const start = "2026-06-02T23:58:30+01:00";
    expect(turnInstant({ time: "23:59", speaker: "Alice", text: "" }, start)).toBe(Date.parse("2026-06-02T23:59:00+01:00"));
    expect(turnInstant({ time: "00:01", speaker: "Alice", text: "" }, start)).toBe(Date.parse("2026-06-03T00:01:00+01:00"));
    expect(turnInstant({ time: "0:01:10", speaker: null, text: "" }, start)).toBe(Date.parse("2026-06-02T23:59:40+01:00"));
    expect(turnInstant({ time: null, speaker: null, text: "" }, start)).toBeNull();
  });

  it("renders a recording for day summaries with its transcript", () => {
    run(recording());
    const event = db.prepare("SELECT * FROM events WHERE source = ?").get(EVENT_SOURCE) as TimelineEvent;
    const text = renderEvent(event, { timeZone: "Europe/London" });
    expect(text.split("\n")[0]).toMatch(/Recorded outgoing call with \+447700900123 \(3m\)$/);
    expect(text).toContain("13:12 <Bob> Yes, it's me.");
  });
});

describe("call event types", () => {
  it("agree between the SQL filter and the check on loaded rows", () => {
    const types = ["call:incoming", "call:log", "message:call", "message:dm:call", "message:guild:call", "message", "message:dm", "sms:sent", "recording:incoming", "message:dm:attachment", "callback"];
    db.exec("CREATE TABLE t (type TEXT)");
    for (const type of types) db.prepare("INSERT INTO t VALUES (?)").run(type);
    const matched = (db.prepare(`SELECT type FROM t WHERE ${callTypeClause()}`).all() as { type: string }[]).map((row) => row.type);
    expect(matched).toEqual(types.filter(isCallEventType));
    expect(matched).toEqual(["call:incoming", "call:log", "message:call", "message:dm:call", "message:guild:call"]);
  });
});
