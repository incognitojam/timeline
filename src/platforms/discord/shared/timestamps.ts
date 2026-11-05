/**
 * Discord inline timestamp markup: `<t:UNIX_SECONDS>` with an optional style
 * suffix (`<t:1686682800:F>`). Discord renders these in the reader's own
 * timezone and locale.
 *
 * https://docs.discord.com/developers/reference#message-formatting-timestamp-styles
 */

export type DiscordTimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

/** Style Discord applies when the token omits one (`<t:1686682800>`). */
export const DEFAULT_DISCORD_TIMESTAMP_STYLE: DiscordTimestampStyle = "f";

export interface DiscordTimestampStyleParts {
  /** Date precision; "none" omits the date. "numeric" is 20/04/2021, "long" is 20 April 2021. */
  date: "none" | "numeric" | "long";
  /** Time precision; "none" omits the time. */
  time: "none" | "minutes" | "seconds";
  /** Whether the weekday name accompanies the date. */
  weekday: boolean;
  /** Rendered relative to the reading time ("2 months ago"); the fields above describe its absolute form. */
  relative: boolean;
}

export const DISCORD_TIMESTAMP_STYLES: Record<DiscordTimestampStyle, DiscordTimestampStyleParts> = {
  t: { date: "none", time: "minutes", weekday: false, relative: false },
  T: { date: "none", time: "seconds", weekday: false, relative: false },
  d: { date: "numeric", time: "none", weekday: false, relative: false },
  D: { date: "long", time: "none", weekday: false, relative: false },
  f: { date: "long", time: "minutes", weekday: false, relative: false },
  F: { date: "long", time: "minutes", weekday: true, relative: false },
  R: { date: "long", time: "minutes", weekday: false, relative: true },
};

/** Largest absolute epoch milliseconds a JS Date can hold. */
const MAX_DATE_MS = 8.64e15;

/**
 * Whether a token's seconds value lands inside the representable Date range.
 * Discord itself renders out-of-range tokens as literal text, and so do we —
 * callers gate on this so downstream formatters never see an Invalid Date.
 */
export function isRenderableDiscordTimestamp(seconds: number): boolean {
  return Number.isFinite(seconds) && Math.abs(seconds) * 1000 <= MAX_DATE_MS;
}

export function discordTimestampToDate(seconds: number): Date {
  return new Date(seconds * 1000);
}

const plainFormatters = new Map<string, Intl.DateTimeFormat>();

function getPlainFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = plainFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    plainFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const part = parts.find((p) => p.type === type);
  if (!part) {
    throw new Error(`Formatted Discord timestamp is missing ${type}`);
  }
  return part.value;
}

/**
 * Locale-free rendering for plain-text surfaces (exports, MCP, timeline cards):
 * `2021-04-20 16:20` in `timeZone` (UTC when unset). Relative tokens render
 * absolutely too — "2 months ago" would mean something different every time the
 * export is read.
 */
export function formatDiscordTimestampPlain(
  seconds: number,
  style: DiscordTimestampStyle,
  timeZone?: string,
): string {
  const parts = getPlainFormatter(timeZone ?? "UTC").formatToParts(discordTimestampToDate(seconds));
  const { date, time } = DISCORD_TIMESTAMP_STYLES[style];

  const datePart = date === "none"
    ? null
    : [partValue(parts, "year"), partValue(parts, "month"), partValue(parts, "day")].join("-");
  const timePart = time === "none"
    ? null
    : time === "seconds"
      ? `${partValue(parts, "hour")}:${partValue(parts, "minute")}:${partValue(parts, "second")}`
      : `${partValue(parts, "hour")}:${partValue(parts, "minute")}`;

  return [datePart, timePart].filter((p) => p !== null).join(" ");
}
