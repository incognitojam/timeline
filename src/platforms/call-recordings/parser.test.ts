import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "../../db/sqlite";
import { initDb } from "../../db/schema";
import { readAmr } from "./amr";
import { parseRecordingName, zonedInstant } from "./filename";
import { callTypeClause, isCallEventType } from "./match";
import { type Converter, EVENT_SOURCE, type ImportOptions, importRecordingFile } from "./parser";
import { readRecording } from "./shared/recording";
import { parseTranscript, turnInstant } from "./shared/transcript";

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

/** An AMR-NB file of `seconds` of 12.2 kbit/s frames (header 0x3c, 31 bytes each). */
function amrNb(seconds: number, seed = 0): Uint8Array {
  const frames = seconds * 50;
  const bytes = new Uint8Array(6 + frames * 32).fill(seed);
  bytes.set(new TextEncoder().encode("#!AMR\n"), 0);
  for (let i = 0; i < frames; i++) bytes[6 + i * 32] = 0x3c;
  return bytes;
}

function recordingFile(name: string, seconds = 150, seed = 0): string {
  const path = join(dir, name);
  writeFileSync(path, amrNb(seconds, seed));
  return path;
}

const toWav: Converter = async () => ({ bytes: new TextEncoder().encode("RIFF-audio"), extension: ".wav", mimeType: "audio/wav" });

function options(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return { sourceAccount: "owner", importBatch: "test", timeZone: "Europe/London", convert: toWav, ...overrides };
}

let nextCall = 0;
/** A call event another source imported, with its start, length and people. */
function call(start: string, durationMs: number, people: string[], title: string): number {
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

interface Row {
  id: number;
  source_id: string;
  timestamp: string;
  end_timestamp: string;
  duration_ms: number;
  title: string;
  people: string;
  raw_data: string;
}

function rows(): Row[] {
  return db.prepare("SELECT * FROM events WHERE source = ? ORDER BY id").all(EVENT_SOURCE) as Row[];
}

function attachments(eventId: number): { filename: string; mime_type: string; status: string }[] {
  return db.prepare("SELECT filename, mime_type, status FROM attachments WHERE event_id = ? ORDER BY id").all(eventId) as never;
}

describe("Cube file names", () => {
  it("reads the app, the local start and a number, normalised like the call log's", () => {
    expect(parseRecordingName("phone_20260315-181753_07700900123.amr")).toEqual({
      app: "phone",
      recordedAt: "20260315-181753",
      local: { year: 2026, month: 3, day: 15, hour: 18, minute: 17, second: 53 },
      contact: "07700900123",
      number: "+447700900123",
    });
    // Cube writes an international number's + as _.
    expect(parseRecordingName("phone_20260311-115151__447700900123.amr")).toMatchObject({ contact: "_447700900123", number: "+447700900123" });
  });

  it("keeps any other contact text as a hint only, underscores and spaces included, and a missing one as none", () => {
    expect(parseRecordingName("whatsapp_20261109-065019_John Doe.amr")).toMatchObject({ app: "whatsapp", contact: "John Doe", number: null });
    expect(parseRecordingName("gmeet_20260410-224125_Google meeting.amr")).toMatchObject({ app: "gmeet", contact: "Google meeting", number: null });
    expect(parseRecordingName("facebook_20260831-085326_08_53.amr")).toMatchObject({ app: "facebook", contact: "08_53", number: null });
    expect(parseRecordingName("gmeet_20260410-224125_2026-04-10.amr")).toMatchObject({ contact: "2026-04-10", number: null });
    expect(parseRecordingName("phone_20260717-181323.amr")).toMatchObject({ app: "phone", recordedAt: "20260717-181323", contact: null, number: null });
  });

  it("refuses anything else rather than guessing", () => {
    for (const name of [
      "skype_20260315-181753_07700900123.amr",
      "phone_2026-03-15 18-17-53_07700900123.amr",
      "phone_20260315181753_07700900123.amr",
      "phone_20260230-181753_07700900123.amr",
      "phone_20260315-241753_07700900123.amr",
      "phone_20260315-181753_07700900123.m4a",
      "Recording 1.amr",
    ]) {
      expect(parseRecordingName(name)).toBeNull();
    }
  });

  it("reads the time in the phone's zone, across a clock change", () => {
    const local = (month: number, day: number, hour: number) => ({ year: 2026, month, day, hour, minute: 0, second: 0 });
    expect(zonedInstant(local(1, 15, 12), "Europe/London").toISOString()).toBe("2026-01-15T12:00:00.000Z");
    expect(zonedInstant(local(6, 15, 12), "Europe/London").toISOString()).toBe("2026-06-15T11:00:00.000Z");
    expect(zonedInstant(local(3, 29, 3), "Europe/London").toISOString()).toBe("2026-03-29T02:00:00.000Z");
  });
});

describe("AMR length", () => {
  it("counts 20 ms frames of any mode, narrowband or wideband", () => {
    expect(readAmr(amrNb(3))).toEqual({ codec: "AMR-NB", frames: 150, durationMs: 3000 });
    // Wideband: a 23.85 kbit/s frame (type 8, 60 bytes), then a no-data frame.
    const wb = new Uint8Array([...new TextEncoder().encode("#!AMR-WB\n"), 0x44, ...new Uint8Array(60), 0x7c]);
    expect(readAmr(wb)).toEqual({ codec: "AMR-WB", frames: 2, durationMs: 40 });
  });

  it("rejects a file cut off mid-frame, with no frames, or that isn't AMR", () => {
    expect(() => readAmr(amrNb(1).subarray(0, 40))).toThrow("part-way through a frame");
    expect(() => readAmr(new TextEncoder().encode("RIFF...."))).toThrow("not a single-channel AMR file");
    expect(() => readAmr(new TextEncoder().encode("#!AMR\n"))).toThrow("has no frames");
  });
});

describe("call recordings importer", () => {
  it("imports a numbered recording as that number's phone identity, with both copies of its audio", async () => {
    const outcome = await importRecordingFile(db, recordingFile("phone_20260315-181753_07700900123.amr"), options());
    expect(outcome).toMatchObject({ status: "imported", playable: true });
    const [row] = rows();
    expect(row).toMatchObject({
      source_id: "phone_20260315-181753_07700900123.amr",
      timestamp: "2026-03-15T18:17:53.000Z",
      end_timestamp: "2026-03-15T18:20:23.000Z",
      duration_ms: 150_000,
      title: "+447700900123",
      people: JSON.stringify(["phone:+447700900123"]),
    });
    expect(readRecording(row?.raw_data)).toMatchObject({ app: "phone", contact: "07700900123", playable: true });
    expect(attachments(row?.id ?? 0)).toEqual([
      { filename: "phone_20260315-181753_07700900123.amr", mime_type: "audio/amr", status: "stored" },
      { filename: "phone_20260315-181753_07700900123.wav", mime_type: "audio/wav", status: "stored" },
    ]);
    expect(db.prepare("SELECT platform_id FROM identities WHERE platform = 'phone'").all()).toEqual([{ platform_id: "+447700900123" }]);
  });

  it("imports audio once under any name, and leaves different audio under a used name alone", async () => {
    const first = await importRecordingFile(db, recordingFile("phone_20260315-181753_07700900123.amr"), options());
    const again = await importRecordingFile(db, recordingFile("phone_20260315-181753_07700900123.amr"), options());
    const renamed = await importRecordingFile(db, recordingFile("phone_20260717-181323.amr"), options());
    expect(first.status).toBe("imported");
    expect(again).toEqual({ status: "duplicate", eventId: rows()[0]?.id ?? 0 });
    expect(renamed.status).toBe("duplicate");
    const changed = recordingFile("phone_20260315-181753_07700900123.amr", 150, 1);
    await expect(importRecordingFile(db, changed, options())).rejects.toThrow("already holds different audio under this name");
    expect(rows()).toHaveLength(1);
  });

  it("waits with a recording without a number until exactly one Timeline call overlaps it", async () => {
    const path = recordingFile("whatsapp_20261109-065019_John Doe.amr");
    expect(await importRecordingFile(db, path, options())).toEqual({ status: "waiting", reason: "no Timeline call overlaps it yet" });

    const first = call("2026-11-09T06:50:00.000Z", 180_000, ["phone:owner", "phone:+447700900123"], "John Doe");
    const second = call("2026-11-09T06:51:00.000Z", 60_000, ["phone:owner"], "Unknown caller");
    expect(await importRecordingFile(db, path, options())).toEqual({ status: "waiting", reason: "2 Timeline calls overlap it" });
    expect(rows()).toHaveLength(0);

    db.prepare("DELETE FROM events WHERE id = ?").run(second);
    expect((await importRecordingFile(db, path, options())).status).toBe("imported");
    expect(rows()[0]).toMatchObject({ title: "John Doe", people: JSON.stringify(["phone:owner", "phone:+447700900123"]) });
    expect(readRecording(rows()[0]?.raw_data)).toMatchObject({ contact: "John Doe", number: null });
    expect(first).toBeGreaterThan(0);
  });

  it("imports without a playable copy when conversion fails, and says why", async () => {
    const fails: Converter = async () => {
      throw new Error("afconvert is only available on macOS");
    };
    const outcome = await importRecordingFile(db, recordingFile("phone_20260315-181753_07700900123.amr"), options({ convert: fails }));
    expect(outcome).toMatchObject({ status: "imported", playable: false });
    expect(readRecording(rows()[0]?.raw_data)).toMatchObject({ playable: false, unplayable_reason: "afconvert is only available on macOS" });
    expect(attachments(rows()[0]?.id ?? 0).map((a) => a.mime_type)).toEqual(["audio/amr"]);
  });

  it("refuses a file it can't name or read, writing nothing", async () => {
    await expect(importRecordingFile(db, recordingFile("Recording 1.amr"), options())).rejects.toThrow("is not named like a Cube ACR recording");
    const truncated = join(dir, "phone_20260315-181753_07700900123.amr");
    writeFileSync(truncated, amrNb(1).subarray(0, 40));
    await expect(importRecordingFile(db, truncated, options())).rejects.toThrow("part-way through a frame");
    expect(rows()).toHaveLength(0);
  });
});

describe("the cube-acr inbox source", () => {
  it("leaves a waiting recording in the inbox, unmarked, and imports and archives it on a later run", async () => {
    const root = join(dir, "inbox");
    mkdirSync(root);
    writeFileSync(join(root, "whatsapp_20261109-065019_John Doe.amr"), amrNb(150));
    const resultPath = join(dir, "result.json");
    const script = `
      import { processSource } from ${JSON.stringify(join(import.meta.dir, "../../inbox/process.ts"))};
      import { getAppStateDb } from ${JSON.stringify(join(import.meta.dir, "../../db/app-state.ts"))};
      import { getDb } from ${JSON.stringify(join(import.meta.dir, "../../db/schema.ts"))};
      const source = { type: "local", local: ${JSON.stringify(root)}, parser: "cube-acr", account: "owner", patterns: ["*.amr"] };
      const config = { sources: { calls: source }, inbox_path: ${JSON.stringify(root)}, archive_path: ${JSON.stringify(join(dir, "archive"))} };
      const state = () => ({
        processed: getAppStateDb().query("SELECT count(*) AS n FROM processed_files").get().n,
        logs: getAppStateDb().query("SELECT count(*) AS n FROM sync_log").get().n,
      });
      const first = await processSource(config, "calls", source, {});
      const afterFirst = state();
      const db = getDb();
      db.run("INSERT INTO events (source, source_id, source_account, type, timestamp, duration_ms, title, people, raw_data, conversation_id) VALUES ('phone', 'c1', 'owner', 'call:incoming', '2026-11-09T06:50:00.000Z', 180000, 'John Doe', '[\\"phone:+447700900123\\"]', '{}', '+447700900123')");
      const second = await processSource(config, "calls", source, {});
      const events = db.query("SELECT title FROM events WHERE source = 'call-recordings'").all();
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ first, afterFirst, second, afterSecond: state(), events }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, TZ: "Europe/London", TIMELINE_DB_PATH: join(dir, "inbox.db") }, stdout: "pipe", stderr: "pipe" });
    const code = await child.exited;
    expect({ code, stderr: await new Response(child.stderr).text() }).toMatchObject({ code: 0 });
    const result = await Bun.file(resultPath).json();
    expect(result.first).toMatchObject({ filesProcessed: 0, filesWaiting: 1, errors: [] });
    expect(result.afterFirst).toEqual({ processed: 0, logs: 0 });
    expect(result.second).toMatchObject({ filesProcessed: 1, filesWaiting: 0, eventsAdded: 1, errors: [] });
    expect(result.afterSecond).toEqual({ processed: 1, logs: 1 });
    expect(result.events).toEqual([{ title: "John Doe" }]);
    expect(await Bun.file(join(dir, "archive/calls/whatsapp_20261109-065019_John Doe.amr")).exists()).toBe(true);
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
