import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "../../db/sqlite";
import { wrapDatabase } from "../../db/pool";
import { initDb } from "../../db/schema";
import { parseRange, recordingAudioResponse } from "./audio";
import { type Converter, importRecordingFile } from "./parser";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = join(tmpdir(), `call-audio-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Import a one-frame recording whose playable copy, if any, is `copy`. */
async function imported(name: string, copy: string | null): Promise<number> {
  const path = join(dir, name);
  writeFileSync(path, new Uint8Array([...new TextEncoder().encode("#!AMR\n"), 0x7c]));
  const convert: Converter = async () => {
    if (copy === null) throw new Error("no converter here");
    return { bytes: new TextEncoder().encode(copy), extension: ".wav", mimeType: "audio/wav" };
  };
  const outcome = await importRecordingFile(db, path, { sourceAccount: "owner", importBatch: "test", timeZone: "UTC", convert });
  if (outcome.status !== "imported") throw new Error(`not imported: ${outcome.status}`);
  return outcome.eventId;
}

describe("call recording audio", () => {
  it("parses single byte ranges and rejects ones it cannot satisfy", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=9-3", 100)).toBe("invalid");
    expect(parseRange("items=0-1", 100)).toBe("invalid");
  });

  it("serves the playable copy whole, or the range asked for", async () => {
    const id = await imported("phone_20260315-181753_07700900123.amr", "0123456789");
    const whole = await recordingAudioResponse(wrapDatabase(db), id, undefined);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Type")).toBe("audio/wav");
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await whole.text()).toBe("0123456789");

    const part = await recordingAudioResponse(wrapDatabase(db), id, "bytes=2-5");
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(part.headers.get("Content-Length")).toBe("4");
    expect(await part.text()).toBe("2345");

    const beyond = await recordingAudioResponse(wrapDatabase(db), id, "bytes=20-");
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("never serves the AMR original, and 404s for anything that isn't a recording", async () => {
    const id = await imported("phone_20260315-181753_07700900123.amr", null);
    expect((await recordingAudioResponse(wrapDatabase(db), id, undefined)).status).toBe(415);
    expect((await recordingAudioResponse(wrapDatabase(db), id + 1, undefined)).status).toBe(404);
  });
});
