import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseRange, recordingAudioResponse } from "./audio";
import { playableAudio, type CallsRecording } from "./shared/recording";

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `call-audio-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rawData(audio: Partial<CallsRecording["audio"]>): string {
  return JSON.stringify({
    id: "Call_1",
    source: "phone",
    recorded_sides: "both_expected",
    audio: { original: join(dir, "Call_1.amr"), flac: null, levelled: null, ...audio },
  });
}

describe("call recording audio", () => {
  it("picks the first copy a browser can play", () => {
    const recording = (audio: Partial<CallsRecording["audio"]>) => JSON.parse(rawData(audio)) as CallsRecording;
    expect(playableAudio(recording({}))).toBeNull();
    expect(playableAudio(recording({ flac: "/r/Call_1.flac" }))).toEqual({ path: "/r/Call_1.flac", mimeType: "audio/flac" });
    expect(playableAudio(recording({ original: "/r/Pixel_1.M4A", flac: "/r/x.flac" }))?.mimeType).toBe("audio/mp4");
  });

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

  it("serves the whole file, or the range asked for", async () => {
    const flac = join(dir, "Call_1.flac");
    writeFileSync(flac, "0123456789");
    const whole = await recordingAudioResponse(rawData({ flac }), undefined);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Type")).toBe("audio/flac");
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await whole.text()).toBe("0123456789");

    const part = await recordingAudioResponse(rawData({ flac }), "bytes=2-5");
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(part.headers.get("Content-Length")).toBe("4");
    expect(await part.text()).toBe("2345");

    const beyond = await recordingAudioResponse(rawData({ flac }), "bytes=20-");
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("explains when there is nothing a browser can play, or the file has gone", async () => {
    writeFileSync(join(dir, "Call_1.amr"), "amr");
    expect((await recordingAudioResponse(rawData({}), undefined)).status).toBe(415);
    expect((await recordingAudioResponse(rawData({ flac: join(dir, "missing.flac") }), undefined)).status).toBe(404);
    expect((await recordingAudioResponse(rawData({ flac: "relative/Call_1.flac" }), undefined)).status).toBe(500);
  });
});
