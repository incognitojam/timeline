import { join } from "node:path";
import type { SeedContext, SeedDay, SeedSource } from "../../seed/context";
import type { Person, PersonKey } from "../../seed/persona";
import { HOME_DIR, PEOPLE, personByKey, SELF, TIME_ZONE } from "../../seed/persona";
import type { Rng } from "../../seed/rng";
import { EVENT_SOURCE, importCallRecordings, parseListing, SCHEMA_VERSION } from "./parser";
import type { CallsRecording, CallsTranscript } from "./shared/recording";

const NAME = "call-recordings";
/** Where Alex's call-transcribe folder would be, for audio the seed doesn't write. */
const CALLS_DIR = `${HOME_DIR}/call-transcribe/backlog`;
/** Seeded audio is a short synthetic murmur, not the call's full length. */
const AUDIO_SECONDS = 12;
const SAMPLE_RATE = 8000;
/** Alex's recorder captured only their own side before this many days ago. */
const BOTH_SIDES_DAYS = 45;
/** Seeded phone calls from this far back may have a recording. */
const RECORDED_DAYS = 200;

type Line = readonly ["me" | "them", string];

const OPENERS: readonly (readonly Line[])[] = [
  [["them", "Hey, is now a good time?"], ["me", "Yeah, go for it."]],
  [["me", "Hi, it's me. Have you got a minute?"], ["them", "Sure, what's up?"]],
  [["them", "Hello?"], ["me", "Hey! Sorry, I missed your text earlier."]],
];

const TOPICS: readonly (readonly Line[])[] = [
  [
    ["them", "Are we still on for Saturday?"],
    ["me", "Definitely. I was thinking we start at the trailhead around eight."],
    ["them", "Eight is early, but fine. I'll bring the snacks."],
    ["me", "Perfect. I'll check the weather on Friday night."],
  ],
  [
    ["me", "Did you get a chance to look at the photos I sent?"],
    ["them", "I did, the one by the lake is lovely."],
    ["me", "That's my favourite too. I might get it printed."],
  ],
  [
    ["them", "How did the release go this week?"],
    ["me", "Mostly fine. One migration took longer than we planned, but nothing broke."],
    ["them", "That's a relief."],
    ["me", "Yeah, I can finally relax this weekend."],
  ],
  [
    ["them", "I booked the table for Thursday at seven."],
    ["me", "Great, the noodle place?"],
    ["them", "That's the one. Bring a jacket, it's on the patio."],
  ],
  [
    ["me", "I found a recipe for the soup you made last month."],
    ["them", "Oh, the lentil one? Add more ginger than it says."],
    ["me", "Noted. I'll make it on Sunday."],
  ],
  [
    ["them", "Your sister says you're thinking about a new bike."],
    ["me", "Thinking, yes. Buying, not yet."],
    ["them", "Well, let me know if you want to borrow mine first."],
  ],
];

const CLOSERS: readonly (readonly Line[])[] = [
  [["me", "Okay, I'll let you go. Talk soon."], ["them", "Bye, take care."]],
  [["them", "Right, I'd better head off."], ["me", "Sure, speak later."]],
];

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

function localParts(at: Date): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const parts = Object.fromEntries(zoneParts.formatToParts(at).map((part) => [part.type, part.value]));
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
}

/** ISO with Alex's local offset, as `calls` writes Europe/London times for its owner. */
function localIso(ctx: SeedContext, at: Date): string {
  const p = localParts(at);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${ctx.localOffset(at)}`;
}

function clock(at: Date): string {
  const p = localParts(at);
  return `${p.hour}:${p.minute}`;
}

function offset(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function dialogue(rng: Rng): Line[] {
  const topics = rng.sample(TOPICS, rng.int(1, 2));
  return [...rng.pick(OPENERS), ...topics.flat(), ...rng.pick(CLOSERS)];
}

/** A Scribe transcript: both voices, named, local wall-clock times. */
function scribeText(lines: readonly Line[], other: string, start: Date, durationS: number): string {
  const header = `# Call with: ${other} (${start.toLocaleDateString("en-GB", { timeZone: TIME_ZONE, day: "numeric", month: "short", year: "numeric" })}, ${clock(start)})`;
  const step = durationS / lines.length;
  const turns = lines.map(([who, text], index) => {
    const at = new Date(start.getTime() + index * step * 1000);
    return `${clock(at)} <${who === "me" ? SELF.first : other}> ${text.replace(/([.?!]) /g, "$1\n")}`;
  });
  return [header, "", turns.join("\n\n"), ""].join("\n");
}

/** A Parakeet transcript of a near-side-only recording: Alex's lines, offsets from the start. */
function parakeetText(lines: readonly Line[], durationS: number): string {
  const step = durationS / lines.length;
  return lines
    .flatMap(([who, text], index) => (who === "me" ? [`[${offset(index * step + 2)}] ${text}`] : []))
    .join("\n")
    .concat("\n");
}

interface Draft {
  app: string;
  start: Date;
  durationS: number;
  precisionS: number;
  direction: "incoming" | "outgoing" | null;
  person: Person | null;
  /** Name as the recorder stored it, for recordings without a number. */
  contact: string | null;
  withNumber: boolean;
  sides: string;
  /** null: not transcribed (yet). */
  transcript: "scribe" | "parakeet" | null;
}

function stamp(at: Date): string {
  const p = localParts(at);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}

const ENGINES = {
  scribe: { kind: "scribe-api", engine: "elevenlabs-scribe-v2", folder: "scribe-api" },
  parakeet: { kind: "parakeet", engine: "parakeet-tdt-0.6b-v3", folder: "transcripts" },
} as const;

/** Write a transcript the way call-transcribe would, and describe it as `calls` does. */
function transcribe(ctx: SeedContext, rng: Rng, dir: string, id: string, draft: Draft & { transcript: "scribe" | "parakeet" }, end: Date): CallsTranscript {
  const lines = dialogue(rng);
  const other = draft.contact ?? draft.person?.first ?? "speaker_1";
  const scribe = draft.transcript === "scribe";
  const text = scribe ? scribeText(lines, other, draft.start, draft.durationS) : parakeetText(lines, draft.durationS);
  const { kind, engine, folder } = ENGINES[draft.transcript];
  return {
    kind,
    engine,
    json: join(dir, folder, `${id}.json`),
    txt: ctx.writeStaged(NAME, `${folder}/${id}.txt`, text),
    created_at: localIso(ctx, new Date(end.getTime() + rng.int(1, 72) * 3_600_000)),
    words: text.split(/\s+/).length,
    speakers_labelled: scribe ? true : null,
    ...(scribe ? { edited_turns: 0, speaker_names: { speaker_0: SELF.first, speaker_1: other } } : {}),
  };
}

/**
 * A mono 16-bit WAV of two "voices" (hummed tones) taking turns, or silence:
 * enough for the player to have something to play without any real speech.
 */
function murmur(rng: Rng, silent: boolean): Uint8Array {
  const samples = AUDIO_SECONDS * SAMPLE_RATE;
  const data = new Int16Array(samples);
  if (!silent) {
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

/**
 * Recordings from the near-side-only era keep an AMR original that browsers
 * can't play (and the seed doesn't write); later ones get playable audio.
 */
function audioFor(ctx: SeedContext, rng: Rng, id: string, draft: Draft): CallsRecording["audio"] {
  if (draft.sides === "near_side_only") {
    return { original: `${CALLS_DIR}/CubeCallRecorder/All/${id}.amr`, flac: null, levelled: null };
  }
  const folder = draft.app === "pixel" ? "pixel" : "CubeCallRecorder/All";
  return { original: ctx.writeMedia(`call-transcribe/${folder}/${id}.wav`, murmur(rng, draft.sides === "silent")), flac: null, levelled: null };
}

function build(ctx: SeedContext, rng: Rng, dir: string, draft: Draft): CallsRecording {
  const end = new Date(draft.start.getTime() + draft.durationS * 1000);
  const number = draft.withNumber && draft.person ? draft.person.phone : null;
  const pixel = draft.app === "pixel";
  const label = number ?? draft.contact ?? draft.person?.name ?? "";
  const id = `${pixel ? "Pixel" : "Call"}_${stamp(draft.start)}_${label.replace(/[^\w+]/g, "")}`;
  const transcripts = draft.transcript ? [transcribe(ctx, rng, dir, id, { ...draft, transcript: draft.transcript }, end)] : [];
  return {
    id,
    sha1: rng.hex(40),
    source: draft.app,
    start: localIso(ctx, draft.start),
    end: localIso(ctx, end),
    start_precision_s: draft.precisionS,
    duration_s: draft.durationS,
    direction: draft.direction,
    number,
    contact: number ? null : draft.contact,
    caller_unknown: !number && !draft.contact,
    recorded_sides: draft.sides,
    audio: audioFor(ctx, rng, id, draft),
    transcripts,
    best_transcript: transcripts[0]?.txt ?? null,
    updated_at: localIso(ctx, end),
    fingerprint: rng.hex(16),
  };
}

interface SeededCall {
  timestamp: string;
  duration_ms: number;
  type: string;
  title: string;
  people: string;
}

const BY_IDENTIFIER = new Map<string, Person>(
  PEOPLE.flatMap((person) => [[`phone:${person.phone}`, person], [`facebook:name:${person.name}`, person]] as const),
);

function personIn(call: SeededCall): Person | undefined {
  return (JSON.parse(call.people) as string[]).map((id) => BY_IDENTIFIER.get(id)).find((p) => p !== undefined);
}

function transcriptFor(rng: Rng, sides: string): Draft["transcript"] {
  if (sides === "near_side_only") return rng.chance(0.8) ? "parakeet" : null;
  return rng.chance(0.85) ? "scribe" : null;
}

export const callRecordingsSeed: SeedSource = {
  name: NAME,
  produces: { [EVENT_SOURCE]: ["recording:incoming", "recording:outgoing", "recording:unknown"] },
  async seed(ctx: SeedContext) {
    const rng = ctx.rng(NAME);
    const dir = ctx.stage(NAME);
    const anchor = ctx.localDate(ctx.anchorDate, 23, 59).getTime();
    const daysAgo = (at: Date) => (anchor - at.getTime()) / 86_400_000;
    const sidesFor = (at: Date) => (daysAgo(at) < BOTH_SIDES_DAYS ? "both_expected" : "near_side_only");
    const drafts: Draft[] = [];

    // Answered calls other generators seeded, so run this after `phone` and `facebook`.
    const since = new Date(anchor - RECORDED_DAYS * 86_400_000).toISOString();
    const phoneCalls = ctx.db
      .prepare(
        `SELECT timestamp, duration_ms, type, title, people FROM events
         WHERE source = 'phone' AND type IN ('call:incoming', 'call:outgoing') AND duration_ms >= 60000 AND timestamp >= ?
         ORDER BY timestamp`,
      )
      .all(since) as SeededCall[];
    const facebookCalls = ctx.db
      .prepare(
        `SELECT timestamp, duration_ms, type, title, people FROM events
         WHERE source = 'facebook' AND type = 'message:call' AND duration_ms >= 60000 ORDER BY timestamp DESC LIMIT 3`,
      )
      .all() as SeededCall[];
    const recordedAfter = (call: SeededCall) => new Date(Date.parse(call.timestamp) + rng.int(2, 9) * 1000);
    const lengthOf = (call: SeededCall) => Math.max(30, call.duration_ms / 1000 - rng.int(0, 4)) + rng.int(0, 99) / 100;

    const unrecorded: SeededCall[] = [];
    for (const call of phoneCalls) {
      const person = personIn(call);
      if (!person) continue;
      const start = recordedAfter(call);
      const sides = rng.chance(0.08) ? "silent" : sidesFor(start);
      const draft = {
        app: "phone", start, durationS: lengthOf(call), precisionS: 1,
        direction: call.type === "call:incoming" ? "incoming" : "outgoing", person, contact: null, sides,
        transcript: sides === "silent" ? null : transcriptFor(rng, sides),
      } as const;
      // Half the calls are recorded with their number; a few more without one
      // (the recorder didn't catch it), which takes its caller from this call.
      if (rng.chance(0.5)) drafts.push({ ...draft, withNumber: true });
      else if (rng.chance(0.08)) drafts.push({ ...draft, withNumber: false });
      else unrecorded.push(call);
    }
    // A speakerphone call recorded on the Pixel: the name was typed by hand.
    const roomCall = unrecorded.at(-1);
    const roomPerson = roomCall ? personIn(roomCall) : undefined;
    if (roomCall && roomPerson) {
      drafts.push({
        app: "pixel", start: new Date(Math.floor(Date.parse(roomCall.timestamp) / 60_000) * 60_000 + 60_000),
        durationS: lengthOf(roomCall), precisionS: 60, direction: null, person: roomPerson,
        contact: roomPerson.first.toLowerCase(), withNumber: false, sides: "room", transcript: "scribe",
      });
    }
    for (const call of facebookCalls) {
      const person = personIn(call);
      if (!person) continue;
      drafts.push({
        app: "facebook", start: recordedAfter(call), durationS: lengthOf(call), precisionS: 1, direction: null,
        person, contact: call.title, withNumber: false, sides: "both_expected", transcript: transcriptFor(rng, "both_expected"),
      });
    }

    // Calls Timeline has no call event for: recent phone calls (the log is
    // imported by hand and lags) still import by number; WhatsApp and Meet
    // calls, and a caller the recorder didn't catch, wait for one.
    const recent = ctx.recentDays(BOTH_SIDES_DAYS);
    const at = (spread: readonly SeedDay[]) => {
      const day = rng.pick(spread);
      return ctx.localDate(day.date, rng.int(9, 21), rng.int(0, 59), rng.int(0, 59));
    };
    const phoneOnly: readonly PersonKey[] = ["linda", "mei", "rowan"];
    for (const key of phoneOnly) {
      drafts.push({
        app: "phone", start: at(recent.slice(-5)), durationS: rng.int(120, 900), precisionS: 1,
        direction: rng.chance(0.5) ? "incoming" : "outgoing", person: personByKey(key), contact: null,
        withNumber: true, sides: "both_expected", transcript: "scribe",
      });
    }
    drafts.push({
      app: "phone", start: at(recent.slice(-3)), durationS: rng.int(60, 400), precisionS: 1, direction: "incoming",
      person: null, contact: null, withNumber: false, sides: "both_expected", transcript: null,
    });
    for (const key of ["mei", "rowan", "priya"] as const) {
      const person = personByKey(key);
      drafts.push({
        app: "whatsapp", start: at(recent), durationS: rng.int(180, 2400), precisionS: 1, direction: null,
        person, contact: person.name, withNumber: false, sides: "both_expected", transcript: "scribe",
      });
    }
    drafts.push({
      app: "gmeet", start: at(recent), durationS: rng.int(900, 2700), precisionS: 1, direction: null,
      person: personByKey("jordan"), contact: personByKey("jordan").name, withNumber: false, sides: "both_expected", transcript: "scribe",
    });

    drafts.sort((a, b) => a.start.getTime() - b.start.getTime());
    const recordings = drafts.map((draft) => build(ctx, rng, dir, draft));
    const listing = parseListing(JSON.stringify({ schema_version: SCHEMA_VERSION, count: recordings.length, recordings }));
    await ctx.inTransaction(async () => {
      importCallRecordings(ctx.db, listing, { sourceAccount: SELF.handle, importBatch: `${NAME}-seed` });
    });

    for (const [index, draft] of drafts.entries()) {
      const number = recordings[index]?.number;
      if (draft.person && number) ctx.identify(draft.person.key, `phone:${number}`);
    }
  },
};
