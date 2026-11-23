import type { SeedContext, SeedDay, SeedSource } from "../../seed/context";
import type { Person, PersonKey } from "../../seed/persona";
import { PEOPLE, personByKey, SELF, TIME_ZONE } from "../../seed/persona";
import type { Rng } from "../../seed/rng";
import type { RECORDING_APPS } from "./filename";
import { type Converter, EVENT_SOURCE, importRecordingFile } from "./parser";

const NAME = "call-recordings";
/** Seeded playable copies are a short synthetic murmur, not the call's full length. */
const AUDIO_SECONDS = 12;
const SAMPLE_RATE = 8000;
/** Seeded phone calls from this far back may have a recording. */
const RECORDED_DAYS = 200;
/** An AMR-NB frame header with no speech in it (frame type 15). */
const NO_DATA_FRAME = 0x7c;
/** A comfort-noise frame (type 8): its header and 5 bytes of parameters. */
const SID_FRAME = new Uint8Array([0x44, 0, 0, 0, 0, 0]);

interface Draft {
  app: (typeof RECORDING_APPS)[number];
  start: Date;
  durationS: number;
  /** Who Cube says the call was with: a number, a saved name, or nothing. */
  contact: string;
}

const zoneParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Cube's name for a recording, in Alex's local time; it writes a number's `+` as `_`. */
function fileName(draft: Draft): string {
  const p = Object.fromEntries(zoneParts.formatToParts(draft.start).map((part) => [part.type, part.value]));
  const contact = draft.contact ? `_${draft.contact.replace(/^\+/, "_")}` : "";
  return `${draft.app}_${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}${contact}.amr`;
}

/**
 * A valid AMR-NB file of the call's length, all of it silence. It opens with a
 * comfort-noise frame holding `variant`, so calls of equal length still differ.
 */
function amr(durationS: number, variant: number): Uint8Array {
  const magic = new TextEncoder().encode("#!AMR\n");
  const frames = Math.round(durationS * 50);
  const bytes = new Uint8Array(magic.length + SID_FRAME.length + frames - 1).fill(NO_DATA_FRAME);
  bytes.set(magic, 0);
  bytes.set(SID_FRAME, magic.length);
  new DataView(bytes.buffer).setUint32(magic.length + 1, variant);
  return bytes;
}

/**
 * A mono 16-bit WAV of two "voices" (hummed tones) taking turns: enough for
 * the player to have something to play without any real speech.
 */
function murmur(rng: Rng): Uint8Array {
  const samples = AUDIO_SECONDS * SAMPLE_RATE;
  const data = new Int16Array(samples);
  let at = 0;
  let voice = 0;
  while (at < samples) {
    const length = Math.min(samples - at, Math.round(rng.float(0.8, 2.6) * SAMPLE_RATE));
    const pitch = voice === 0 ? rng.float(150, 190) : rng.float(220, 270);
    for (let i = 0; i < length; i++) {
      const t = i / SAMPLE_RATE;
      const envelope = Math.sin((Math.PI * i) / length) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
      const tone = Math.sin(2 * Math.PI * pitch * t) + 0.4 * Math.sin(4 * Math.PI * pitch * t);
      data[at + i] = Math.round(envelope * tone * 6000);
    }
    at += length + Math.round(rng.float(0.1, 0.5) * SAMPLE_RATE);
    voice = 1 - voice;
  }
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, text: string) => [...text].forEach((char, i) => header.setUint8(offset + i, char.charCodeAt(0)));
  ascii(0, "RIFF");
  header.setUint32(4, 36 + data.byteLength, true);
  ascii(8, "WAVEfmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, "data");
  header.setUint32(40, data.byteLength, true);
  const wav = new Uint8Array(44 + data.byteLength);
  wav.set(new Uint8Array(header.buffer), 0);
  wav.set(new Uint8Array(data.buffer), 44);
  return wav;
}

interface SeededCall {
  timestamp: string;
  duration_ms: number;
  people: string;
  title: string;
}

const BY_IDENTIFIER = new Map<string, Person>(
  PEOPLE.flatMap((person) => [[`phone:${person.phone}`, person], [`facebook:name:${person.name}`, person]] as const),
);

function personIn(call: SeededCall): Person | undefined {
  return (JSON.parse(call.people) as string[]).map((id) => BY_IDENTIFIER.get(id)).find((p) => p !== undefined);
}

export const callRecordingsSeed: SeedSource = {
  name: NAME,
  produces: { [EVENT_SOURCE]: ["recording:unknown"] },
  async seed(ctx: SeedContext) {
    const rng = ctx.rng(NAME);
    const anchor = ctx.localDate(ctx.anchorDate, 23, 59).getTime();
    const drafts: Draft[] = [];

    // Answered calls other generators seeded, so run this after `phone` and `facebook`.
    const since = new Date(anchor - RECORDED_DAYS * 86_400_000).toISOString();
    const phoneCalls = ctx.db
      .prepare(
        `SELECT timestamp, duration_ms, people, title FROM events
         WHERE source = 'phone' AND type IN ('call:incoming', 'call:outgoing') AND duration_ms >= 60000 AND timestamp >= ?
         ORDER BY timestamp`,
      )
      .all(since) as SeededCall[];
    const facebookCalls = ctx.db
      .prepare(
        `SELECT timestamp, duration_ms, people, title FROM events
         WHERE source = 'facebook' AND type = 'message:call' AND duration_ms >= 60000 ORDER BY timestamp DESC LIMIT 3`,
      )
      .all() as SeededCall[];
    const recordedAfter = (call: SeededCall) => new Date(Date.parse(call.timestamp) + rng.int(2, 9) * 1000);
    const lengthOf = (call: SeededCall) => Math.max(30, call.duration_ms / 1000 - rng.int(0, 4));

    for (const call of phoneCalls) {
      const person = personIn(call);
      if (!person) continue;
      // Most recorded calls carry the number; a few only the saved name, and
      // take their caller from this call.
      if (rng.chance(0.5)) drafts.push({ app: "phone", start: recordedAfter(call), durationS: lengthOf(call), contact: person.phone });
      else if (rng.chance(0.08)) drafts.push({ app: "phone", start: recordedAfter(call), durationS: lengthOf(call), contact: person.name });
    }
    for (const call of facebookCalls) {
      if (personIn(call)) drafts.push({ app: "facebook", start: recordedAfter(call), durationS: lengthOf(call), contact: call.title });
    }

    // Calls Timeline has no call event for: recent phone calls (the log is
    // imported by hand and lags) still import by number; WhatsApp and Meet
    // calls, and a caller the recorder didn't catch, wait in the inbox.
    const at = (spread: readonly SeedDay[]) => ctx.localDate(rng.pick(spread).date, rng.int(9, 21), rng.int(0, 59), rng.int(0, 59));
    const recent = ctx.recentDays(30);
    for (const key of ["linda", "mei", "rowan"] as const satisfies readonly PersonKey[]) {
      drafts.push({ app: "phone", start: at(recent.slice(-5)), durationS: rng.int(120, 900), contact: personByKey(key).phone });
    }
    drafts.push({ app: "phone", start: at(recent.slice(-3)), durationS: rng.int(60, 400), contact: "" });
    for (const key of ["mei", "rowan", "priya"] as const satisfies readonly PersonKey[]) {
      drafts.push({ app: "whatsapp", start: at(recent), durationS: rng.int(180, 2400), contact: personByKey(key).name });
    }
    drafts.push({ app: "gmeet", start: at(recent), durationS: rng.int(900, 2700), contact: personByKey("jordan").name });

    // A few copies fail, as afconvert does on a file it can't read.
    const convert: Converter = async () => {
      if (rng.chance(0.1)) throw new Error("afconvert exited with 1: the seed made no playable copy of this one");
      return { bytes: murmur(rng), extension: ".wav", mimeType: "audio/wav" };
    };
    drafts.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const [index, draft] of drafts.entries()) {
      const path = ctx.writeStaged(NAME, fileName(draft), amr(draft.durationS, index));
      await importRecordingFile(ctx.db, path, { sourceAccount: SELF.handle, importBatch: `${NAME}-seed`, timeZone: TIME_ZONE, convert });
    }
    for (const draft of drafts) {
      const person = PEOPLE.find((p) => p.phone === draft.contact);
      if (person) ctx.identify(person.key, `phone:${person.phone}`);
    }
  },
};
