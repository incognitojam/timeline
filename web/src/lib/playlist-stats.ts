import type { PlaylistPoint } from "./api";

/** ISO date (YYYY-MM-DD) shifted back by N days, in UTC. */
export function isoDaysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Follower count as of a given date: the most recent reading on or before it,
 * or the earliest reading if the date predates the series. Assumes `series` is
 * sorted ascending by date.
 */
export function countAsOf(series: PlaylistPoint[], isoDate: string): number {
  let value = series[0]?.count ?? 0;
  for (const p of series) {
    if (p.date <= isoDate) value = p.count;
    else break;
  }
  return value;
}

/**
 * Change in follower count over the trailing `days` window: the latest reading
 * minus the count as of `days` ago.
 *
 * Readings are sparse and irregular (mostly backfilled history plus recent
 * daily syncs), so the lower bound is the most recent reading on or before the
 * cutoff (via countAsOf), not an interpolated value. For a series shorter than
 * the window this collapses to the all-time change. Returns null when there
 * aren't two readings to compare.
 */
export function trailingChange(
  series: PlaylistPoint[],
  days: number,
): number | null {
  if (series.length < 2) return null;
  const latest = series[series.length - 1];
  return latest.count - countAsOf(series, isoDaysBefore(latest.date, days));
}

/**
 * An artificial "started empty" anchor for a playlist: a 0-saves point at the
 * creation date. Used to chart growth from creation and to anchor lifetime
 * estimates. Returns null unless `createdDate` is known and strictly predates
 * the first reading, so the anchor never lands on or after a real observation.
 * Kept out of the stored observations — it's a render/compute-time inference,
 * not a recorded reading.
 */
export function creationAnchor(
  createdDate: string | null | undefined,
  series: PlaylistPoint[],
): PlaylistPoint | null {
  if (!createdDate) return null;
  const first = series[0];
  if (first && createdDate >= first.date) return null;
  return { date: createdDate, count: 0 };
}

/**
 * Annualized average change across a series' full span (first → last point).
 * Prepend the creation anchor (see creationAnchor) to get the lifetime
 * saves-per-year rate from an assumed-empty start. Returns null with fewer than
 * two points or a non-positive span.
 */
export function avgPerYear(series: PlaylistPoint[]): number | null {
  if (series.length < 2) return null;
  const first = series[0];
  const last = series[series.length - 1];
  const spanDays = (Date.parse(last.date) - Date.parse(first.date)) / 86_400_000;
  if (spanDays <= 0) return null;
  return Math.round((last.count - first.count) / (spanDays / 365.25));
}

/**
 * Rough saves gained over the trailing year. Prefers the real measured change
 * (trailingChange over actual readings) whenever there are two or more
 * readings. With too little real history it estimates from the creation anchor:
 * the full current count for a playlist younger than a year (it began empty at
 * creation), else the linear annual rate for an older one. Returns
 * { value, estimated } so the UI can mark inferred figures, or null when
 * neither path applies (single reading, no known creation date).
 */
export function pastYearSaves(
  series: PlaylistPoint[],
  createdDate: string | null | undefined,
): { value: number; estimated: boolean } | null {
  const measured = trailingChange(series, 365);
  if (measured !== null) return { value: measured, estimated: false };

  const anchor = creationAnchor(createdDate, series);
  const last = series[series.length - 1];
  if (!anchor || !last) return null;
  const days = (Date.parse(last.date) - Date.parse(anchor.date)) / 86_400_000;
  if (days <= 0) return null;
  const value = days <= 365 ? last.count : Math.round((last.count * 365) / days);
  return { value, estimated: true };
}
