/**
 * What Timeline knows about one Cube ACR recording, stored as the event's
 * raw_data. The importer writes it; links and display code read it back with
 * `readRecording`.
 */
export interface StoredRecording {
  /** The file name, as it arrived in the inbox. */
  file: string;
  /** The app the call was in: phone, whatsapp, gmeet, facebook. */
  app: string;
  /** The date and time as the file name wrote them, in the phone's local time. */
  recorded_at: string;
  /** The time zone `recorded_at` was read in. */
  time_zone: string;
  /** How far the start may be from the real start, in seconds. */
  start_precision_s: number;
  /** The file name's contact text: a hint only, never an identity. */
  contact: string | null;
  /** The number the contact text holds, normalised as the call log's are. */
  number: string | null;
  /** AMR-NB or AMR-WB. */
  codec: string;
  /** Whether a copy browsers play was stored next to the original. */
  playable: boolean;
  /** Why there is no playable copy, when there isn't one. */
  unplayable_reason: string | null;
}

const APP_LABELS: Readonly<Record<string, string>> = {
  phone: "Phone",
  whatsapp: "WhatsApp",
  gmeet: "Google Meet",
  facebook: "Facebook",
};

/** The app a recording came from, for display. */
export function recordingAppLabel(app: string): string {
  return APP_LABELS[app] ?? app;
}

/** Read a stored raw_data payload back; null when it is not a recording record. */
export function readRecording(rawData: unknown): StoredRecording | null {
  let value: unknown = rawData;
  if (typeof rawData === "string") {
    try {
      value = JSON.parse(rawData);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<StoredRecording>;
  if (typeof record.file !== "string" || typeof record.app !== "string" || typeof record.playable !== "boolean") return null;
  return record as StoredRecording;
}
