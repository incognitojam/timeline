/**
 * One recording as call-transcribe's `calls list` reports it (schema_version 1),
 * stored verbatim as the event's raw_data. The importer validates it; display
 * code reads it back with `readRecording`.
 */
export interface CallsTranscript {
  kind: string;
  engine: string;
  json: string;
  txt: string;
  created_at: string;
  words: number;
  speakers_labelled: boolean | null;
  edited_turns?: number;
  speaker_names?: Record<string, string> | null;
}

export interface CallsAudio {
  original: string;
  flac: string | null;
  levelled: string | null;
}

export interface CallsRecording {
  id: string;
  sha1: string;
  /** The app that captured the call: phone, whatsapp, pixel, gmeet, facebook. */
  source: string;
  start: string;
  end: string;
  /** How far `start` may be from the real start: 1 for Cube, 60 for Pixel. */
  start_precision_s: number;
  duration_s: number;
  direction: "incoming" | "outgoing" | null;
  /** E.164. A recording has a number or a contact name, or neither. */
  number: string | null;
  /** A name the recorder stored, sometimes typed by hand: a hint only, never an identity. */
  contact: string | null;
  /** Neither a number nor a name is known. */
  caller_unknown: boolean;
  recorded_sides: string;
  audio: CallsAudio;
  /** Best first. */
  transcripts: CallsTranscript[];
  /** The best transcript's `.txt`. */
  best_transcript: string | null;
  updated_at: string;
  /** Changes whenever any file behind the record changes. */
  fingerprint: string;
}

const APP_LABELS: Readonly<Record<string, string>> = {
  phone: "Phone",
  whatsapp: "WhatsApp",
  pixel: "Pixel recorder",
  gmeet: "Google Meet",
  facebook: "Facebook",
};

/** The app a recording came from, for display. */
export function recordingAppLabel(app: string): string {
  return APP_LABELS[app] ?? app;
}

const SIDES_LABELS: Readonly<Record<string, string>> = {
  near_side_only: "Only your side recorded",
  both_expected: "Both sides recorded",
  silent: "Nothing captured",
  room: "Room recording",
};

/** What the recorder captured, for display. */
export function recordedSidesLabel(sides: string): string {
  return SIDES_LABELS[sides] ?? sides.replaceAll("_", " ");
}

/** Read a stored raw_data payload back; null when it is not a recording record. */
export function readRecording(rawData: unknown): CallsRecording | null {
  let value: unknown = rawData;
  if (typeof rawData === "string") {
    try {
      value = JSON.parse(rawData);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<CallsRecording>;
  if (typeof record.id !== "string" || typeof record.source !== "string" || typeof record.recorded_sides !== "string") {
    return null;
  }
  return record as CallsRecording;
}
