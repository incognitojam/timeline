/**
 * Cube ACR's recording file names: `<app>_YYYYMMDD-HHMMSS[_<contact>].amr`.
 *
 * The whole format lives in `FILE_NAME` below. A name that does not match it
 * is never guessed at: the importer reports it and leaves the file alone.
 */
import { normalizePhoneNumber } from "../../lib/phone";

/** The apps Cube names a recording after. */
export const RECORDING_APPS = ["phone", "whatsapp", "gmeet", "facebook"] as const;

/**
 * `<app>_YYYYMMDD-HHMMSS`, the date and time in the phone's local time, then
 * optionally `_` and the contact: everything up to `.amr`, underscores and
 * spaces included.
 */
const FILE_NAME = new RegExp(`^(${RECORDING_APPS.join("|")})_((\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2}))(?:_(.*))?\\.amr$`, "i");
/**
 * Contact text that is a number: dialling characters only, at least 7 digits.
 * Cube writes an international number's `+` as `_`, so a leading `_` is a `+`.
 */
const NUMBER = /^\+?[\d\s().-]+$/;
const MIN_DIGITS = 7;
/** Apps whose contact text can be a phone number; a Meet or Facebook label never is. */
const NUMBERED_APPS: ReadonlySet<string> = new Set(["phone", "whatsapp"]);
/** The name gives the start to the second. */
export const START_PRECISION_S = 1;

export interface RecordingName {
  app: (typeof RECORDING_APPS)[number];
  /** The date and time exactly as written. */
  recordedAt: string;
  /** Local wall-clock parts of the start. */
  local: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  /** The contact text as written, or null when there is none. */
  contact: string | null;
  /** The number the contact text holds, normalised as the call log's are; null otherwise. */
  number: string | null;
}

function numberIn(contact: string): string | null {
  const dialled = contact.replace(/^_(?=\d)/, "+");
  if (!NUMBER.test(dialled) || dialled.replace(/\D/g, "").length < MIN_DIGITS) return null;
  return normalizePhoneNumber(dialled);
}

/** The parts of a Cube file name, or null when it is not one. */
export function parseRecordingName(fileName: string): RecordingName | null {
  const match = FILE_NAME.exec(fileName);
  if (!match) return null;
  const [, app = "", recordedAt = "", ...rest] = match;
  const [year, month, day, hour, minute, second] = rest.slice(0, 6).map(Number) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const contact = rest[6]?.trim() || null;
  const lowerApp = app.toLowerCase() as RecordingName["app"];
  return {
    app: lowerApp,
    recordedAt,
    local: { year, month, day, hour, minute, second },
    contact,
    number: contact && NUMBERED_APPS.has(lowerApp) ? numberIn(contact) : null,
  };
}

/** The instant a wall-clock time names in `timeZone`. */
export function zonedInstant(local: RecordingName["local"], timeZone: string): Date {
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const offsetAt = (instant: number) => {
    const p = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, Number(part.value)]));
    return Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day, p.hour, p.minute, p.second) - instant;
  };
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return new Date(wall - offsetAt(wall - offsetAt(wall)));
}
