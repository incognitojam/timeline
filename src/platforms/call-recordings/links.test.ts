import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../db/sqlite";
import { wrapDatabase } from "../../db/pool";
import { initDb, type TimelineEvent } from "../../db/schema";
import { batchLinkIdentitiesToContact } from "../../db/identities";
import { createContact } from "../../db/contacts";
import { invalidateHiddenClauseCaches } from "../../db/events";
import { findCallLinks } from "./links";
import { isCallEventType } from "./match";
import { EVENT_SOURCE, importCallRecordings, parseListing } from "./parser";
import type { CallsRecording } from "./shared/recording";

const ALICE = "+447700900123";
const BOB = "+447700900456";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => db.close());

function recording(overrides: Partial<CallsRecording>): CallsRecording {
  const record: Omit<CallsRecording, "caller_unknown"> = {
    id: "Call_1",
    sha1: "a".repeat(40),
    source: "phone",
    start: "2026-06-02T13:00:30+01:00",
    end: "2026-06-02T13:10:30+01:00",
    start_precision_s: 1,
    duration_s: 600,
    direction: "outgoing",
    number: ALICE,
    contact: null,
    recorded_sides: "both_expected",
    audio: { original: "/recordings/Call_1.amr", flac: null, levelled: null },
    transcripts: [],
    best_transcript: null,
    updated_at: "2026-06-02T13:10:30+01:00",
    fingerprint: "f1",
    ...overrides,
  };
  return { ...record, caller_unknown: !record.number && !record.contact };
}

function importRecordings(...recordings: CallsRecording[]): void {
  const listing = parseListing(JSON.stringify({ schema_version: 1, count: recordings.length, recordings }));
  importCallRecordings(db, listing, { sourceAccount: "owner", importBatch: "test" });
}

let nextCall = 0;
/**
 * A call event as its source's importer would store it: start time, duration
 * and participants. The timestamp is stored as given, offset and all.
 */
function call(source: string, type: string, start: string, durationMs: number | null, people: string[], rawData: unknown = {}): number {
  nextCall++;
  const row = db
    .prepare(
      `INSERT INTO events (source, source_id, source_account, type, timestamp, duration_ms, title, people, raw_data, conversation_id)
       VALUES (?, ?, 'owner', ?, ?, ?, 'call', ?, ?, ?) RETURNING id`,
    )
    .get(source, `call-${nextCall}`, type, start, durationMs, JSON.stringify(people), JSON.stringify(rawData), `conv-${nextCall}`) as { id: number };
  return row.id;
}

async function links(): Promise<Record<string, number[]>> {
  const recordings = db.prepare("SELECT * FROM events WHERE source = ? ORDER BY id").all(EVENT_SOURCE) as TimelineEvent[];
  const found = await findCallLinks(wrapDatabase(db), recordings);
  return Object.fromEntries(recordings.map((r) => [r.source_id ?? "", (found.get(r.id) ?? []).map((c) => c.id)]));
}

describe("call recording links", () => {
  it("recognises call events from every source", () => {
    for (const type of ["call:incoming", "call:outgoing", "call:log", "message:call", "message:dm:call", "message:guild:call"]) {
      expect(isCallEventType(type)).toBe(true);
    }
    for (const type of ["message", "message:dm", "sms:sent", "recording:incoming", "message:dm:attachment"]) {
      expect(isCallEventType(type)).toBe(false);
    }
  });

  it("links the call-log entry for the same number, dialled before the recorder started", async () => {
    importRecordings(recording({}));
    const logged = call("phone", "call:outgoing", "2026-06-02T13:00:05+01:00", 595_000, ["phone:owner", `phone:${ALICE}`]);
    call("phone", "call:outgoing", "2026-06-02T13:00:05+01:00", 595_000, ["phone:owner", `phone:${BOB}`]);
    call("phone", "call:incoming", "2026-06-02T15:00:00+01:00", 60_000, [`phone:${ALICE}`, "phone:owner"]);
    expect(await links()).toEqual({ Call_1: [logged] });
  });

  it("links a call-log row imported after the recording", async () => {
    importRecordings(recording({}));
    expect(await links()).toEqual({ Call_1: [] });
    const logged = call("phone", "call:outgoing", "2026-06-02T13:00:10+01:00", 590_000, ["phone:owner", `phone:${ALICE}`]);
    expect(await links()).toEqual({ Call_1: [logged] });
  });

  it("ignores a call that never connected", async () => {
    importRecordings(recording({}));
    call("phone", "call:missed", "2026-06-02T13:00:00+01:00", 0, [`phone:${ALICE}`, "phone:owner"]);
    expect(await links()).toEqual({ Call_1: [] });
  });

  it("links a recording without a number to the one call that placed it, while it is the only one", async () => {
    const facebook = call("facebook", "message:call", "2026-06-02T13:00:20+01:00", 600_000, ["facebook:alice", "facebook:owner"]);
    importRecordings(recording({ source: "whatsapp", number: null, contact: "Ally", direction: null }));
    expect(await links()).toEqual({ Call_1: [facebook] });

    // A second overlapping call makes it ambiguous: the recording stays, unlinked.
    call("phone", "call:incoming", "2026-06-02T13:05:00+01:00", 60_000, ["phone:+447700900999", "phone:owner"]);
    expect(await links()).toEqual({ Call_1: [] });
  });

  it("allows for a recorder that only knows the minute it started", async () => {
    // The call ended 100 s before the minute the recorder reports: within precision plus ringing.
    const logged = call("phone", "call:incoming", "2026-06-02T12:55:00+01:00", 320_000, [`phone:${ALICE}`, "phone:owner"]);
    importRecordings(recording({ source: "pixel", number: null, contact: "alice", start_precision_s: 60, direction: null, start: "2026-06-02T13:02:00+01:00" }));
    expect(await links()).toEqual({ Call_1: [logged] });
  });

  it("gives each call to the nearest of two back-to-back recordings", async () => {
    importRecordings(
      recording({}),
      recording({ id: "Call_2", sha1: "b".repeat(40), start: "2026-06-02T13:11:00+01:00", end: "2026-06-02T13:15:00+01:00", duration_s: 240 }),
    );
    const first = call("phone", "call:outgoing", "2026-06-02T13:00:05+01:00", 600_000, ["phone:owner", `phone:${ALICE}`]);
    const callback = call("phone", "call:incoming", "2026-06-02T13:10:50+01:00", 250_000, [`phone:${ALICE}`, "phone:owner"]);
    expect(await links()).toEqual({ Call_1: [first], Call_2: [callback] });
  });

  it("leaves a recording whose caller had no call standalone", async () => {
    importRecordings(recording({}));
    call("phone", "call:incoming", "2026-06-02T13:00:05+01:00", 600_000, ["phone:+447700900999", "phone:owner"]);
    expect(await links()).toEqual({ Call_1: [] });
  });

  it("compares instants, not text, when a call is stored with a UTC offset", async () => {
    importRecordings(recording({ start: "2026-06-02T12:05:00+00:00", end: "2026-06-02T12:08:00+00:00", duration_s: 180 }));
    // Starts at 12:00Z, which sorts after the recording's "12:05…Z" as text.
    const logged = call("phone", "call:outgoing", "2026-06-02T13:00:00+01:00", 600_000, ["phone:owner", `phone:${ALICE}`]);
    expect(await links()).toEqual({ Call_1: [logged] });
  });

  it("reads Discord's call length and who joined from the call record", async () => {
    // Answered, started 20 minutes before the recording and still running when it began.
    const answered = call("discord", "message:dm:call", "2026-06-02T11:40:00.000Z", null, ["discord:111", "discord:owner"], {
      call: { participants: ["owner", "111"], ended_timestamp: "2026-06-02T12:10:00.000Z" },
    });
    // Missed, right at the recording's start: not a call that was recorded.
    call("discord", "message:dm:call", "2026-06-02T12:00:30.000Z", null, ["discord:111", "discord:owner"], {
      call: { participants: ["111"], ended_timestamp: "2026-06-02T12:01:00.000Z" },
    });
    importRecordings(recording({ source: "whatsapp", number: null, contact: "Ally", direction: null }));
    expect(await links()).toEqual({ Call_1: [answered] });
  });

  it("leaves out calls involving a hidden contact", async () => {
    importRecordings(recording({}));
    db.prepare("INSERT INTO identities (platform, platform_id) VALUES ('phone', ?)").run(BOB);
    const hiddenId = createContact(db, "Bob");
    batchLinkIdentitiesToContact(db, [{ platform: "phone", platformId: BOB, contactId: hiddenId }]);
    db.prepare("UPDATE contacts SET hidden = 1 WHERE id = ?").run(hiddenId);
    invalidateHiddenClauseCaches();
    try {
      // A group call with Alice and hidden Bob.
      call("phone", "call:outgoing", "2026-06-02T13:00:05+01:00", 600_000, ["phone:owner", `phone:${ALICE}`, `phone:${BOB}`]);
      expect(await links()).toEqual({ Call_1: [] });
    } finally {
      invalidateHiddenClauseCaches();
    }
  });

  it("leaves out the call that placed a recording when it involves a hidden contact", async () => {
    call("phone", "call:incoming", "2026-06-02T13:00:05+01:00", 600_000, [`phone:${BOB}`, "phone:owner"]);
    importRecordings(recording({ number: null, contact: null, direction: "incoming" }));
    db.prepare("INSERT INTO identities (platform, platform_id) VALUES ('phone', ?)").run(BOB);
    const hiddenId = createContact(db, "Bob");
    batchLinkIdentitiesToContact(db, [{ platform: "phone", platformId: BOB, contactId: hiddenId }]);
    db.prepare("UPDATE contacts SET hidden = 1 WHERE id = ?").run(hiddenId);
    invalidateHiddenClauseCaches();
    try {
      expect(await links()).toEqual({ Call_1: [] });
    } finally {
      invalidateHiddenClauseCaches();
    }
  });

  it("keeps a recording without a number linked to its call when another recording of that call is nearer", async () => {
    const logged = call("phone", "call:outgoing", "2026-06-02T13:00:00+01:00", 600_000, ["phone:owner", `phone:${ALICE}`]);
    importRecordings(
      recording({ id: "Cube_1", start: "2026-06-02T13:00:30+01:00" }),
      recording({ id: "Pixel_1", sha1: "b".repeat(40), source: "pixel", number: null, contact: "al", direction: null, start_precision_s: 60, start: "2026-06-02T13:01:00+01:00" }),
      recording({ id: "WA_2", sha1: "c".repeat(40), source: "whatsapp", number: null, contact: "Ally", direction: null, start: "2026-06-02T13:02:00+01:00" }),
    );
    expect(await links()).toEqual({ Cube_1: [logged], Pixel_1: [logged], WA_2: [logged] });
  });
});

