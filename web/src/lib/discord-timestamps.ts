import {
  DISCORD_TIMESTAMP_STYLES,
  type DiscordTimestampStyle,
  type DiscordTimestampStyleParts,
  discordTimestampToDate,
} from "@shared/discord-timestamps";

export type { DiscordTimestampStyle } from "@shared/discord-timestamps";
export { discordTimestampToDate } from "@shared/discord-timestamps";

/**
 * The viewer's IANA zone, for plain-text surfaces (condensed timeline snippets)
 * that flatten content instead of rendering a `<time>` element.
 */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function dateTimeOptions(parts: DiscordTimestampStyleParts): Intl.DateTimeFormatOptions {
  const options: Intl.DateTimeFormatOptions = {};
  if (parts.weekday) options.weekday = "long";
  if (parts.date === "numeric") {
    options.year = "numeric";
    options.month = "2-digit";
    options.day = "2-digit";
  } else if (parts.date === "long") {
    options.year = "numeric";
    options.month = "long";
    options.day = "numeric";
  }
  if (parts.time !== "none") {
    options.hour = "2-digit";
    options.minute = "2-digit";
    if (parts.time === "seconds") options.second = "2-digit";
  }
  return options;
}

// Largest unit first: the coarsest unit the difference fills wins. Months and
// years are the usual 30- and 365-day approximations, so a 40-day gap reads as
// "last month".
const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

function formatRelative(date: Date, now: Date): string {
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const diffMs = date.getTime() - now.getTime();
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (Math.abs(diffMs) >= unitMs) {
      return formatter.format(Math.round(diffMs / unitMs), unit);
    }
  }
  return formatter.format(0, "second");
}

/**
 * Render an inline `<t:…>` token the way Discord does: in the viewer's locale
 * and timezone, with `R` relative to `now` (the current time by default, so a
 * relative token reads the same here as it does in the Discord client).
 */
export function formatDiscordTimestamp(
  seconds: number,
  style: DiscordTimestampStyle,
  now: Date = new Date(),
): string {
  const date = discordTimestampToDate(seconds);
  const parts = DISCORD_TIMESTAMP_STYLES[style];
  if (parts.relative) return formatRelative(date, now);
  return date.toLocaleString(undefined, dateTimeOptions(parts));
}

/**
 * The full weekday/date/time form Discord shows on hover, so styles that drop
 * the date (`t`, `T`) or read relatively (`R`) stay pinnable to a real moment.
 */
export function formatDiscordTimestampTooltip(seconds: number): string {
  return discordTimestampToDate(seconds).toLocaleString(
    undefined,
    dateTimeOptions(DISCORD_TIMESTAMP_STYLES.F),
  );
}
