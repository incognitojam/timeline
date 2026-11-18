import type { AttachmentDescriptionHistoryPoint } from "./api";

export type HistoryRange = "30d" | "90d" | "all";

type Point = AttachmentDescriptionHistoryPoint;

/** Window length in days, counted back from today. `null` = everything recorded. */
const RANGE_DAYS: Record<HistoryRange, number | null> = { "30d": 30, "90d": 90, all: null };

export const DAY_MS = 86_400_000;

export function fmt(n: number): string {
  return n.toLocaleString();
}

/** `YYYY-MM-DD` → UTC midnight ms, so day boundaries never drift with the viewer's zone. */
export function parseDay(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

export function formatDay(ms: number, withYear = false): string {
  return new Date(ms).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
  });
}

interface CoverageSnapshot {
  date: string;
  percent: number;
}

/** Only exact recorded snapshots count — a null denominator is never reconstructed. */
export function coverageSnapshot(point: Point): CoverageSnapshot | null {
  const eligible = point.descriptionEligibleHashes;
  const described = point.describedHashes;
  if (eligible === null || described === null || eligible <= 0) return null;
  return { date: point.date, percent: Math.round((described / eligible) * 100) };
}

export interface HistorySummary {
  /** The recorded days inside the selected window. */
  points: Point[];
  /** The window's first and last recorded day. */
  span: { from: string; to: string } | null;
  /** The last end-of-day backlog reading and its change since the first. */
  queue: {
    latest: number;
    latestDate: string;
    firstDepth: number;
    firstDate: string;
    change: number;
  } | null;
  totals: { described: number; skipped: number; failed: number };
  /** The last exact coverage reading and its movement; null until two exist. */
  coverage: { percent: number; delta: number; sinceDate: string } | null;
}

/**
 * Windows the all-history response client-side, so switching ranges never
 * issues another request. The window is counted back from today in UTC,
 * matching how the daily points are bucketed, so a stale dataset reads as
 * empty rather than as recent.
 */
function pointsInRange(recorded: Point[], range: HistoryRange, now: Date): Point[] {
  const days = RANGE_DAYS[range];
  if (days === null || recorded.length === 0) return recorded;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = today - (days - 1) * DAY_MS;
  return recorded.filter((point) => parseDay(point.date) >= cutoff);
}

export function summarizeHistory(recorded: Point[], range: HistoryRange, now: Date): HistorySummary {
  const points = pointsInRange(recorded, range, now);

  const firstPoint = points[0];
  const lastPoint = points.at(-1);
  const span = firstPoint && lastPoint
    ? { from: formatDay(parseDay(firstPoint.date)), to: formatDay(parseDay(lastPoint.date), true) }
    : null;

  const queuePoints = points.filter((point) => point.queueDepth !== null);
  const firstQueue = queuePoints[0];
  const lastQueue = queuePoints.at(-1);
  const queue =
    !firstQueue || !lastQueue || firstQueue.queueDepth === null || lastQueue.queueDepth === null
      ? null
      : {
        latest: lastQueue.queueDepth,
        latestDate: formatDay(parseDay(lastQueue.date)),
        firstDepth: firstQueue.queueDepth,
        firstDate: formatDay(parseDay(firstQueue.date)),
        change: lastQueue.queueDepth - firstQueue.queueDepth,
      };

  const totals = points.reduce(
    (acc, point) => ({
      described: acc.described + point.described,
      skipped: acc.skipped + point.skipped,
      failed: acc.failed + point.failed,
    }),
    { described: 0, skipped: 0, failed: 0 },
  );

  // Coverage stays hidden until two exact snapshots exist in the window, and
  // then reads as one figure plus its movement: the stats header remains the
  // live source of truth for the current percentage.
  const snapshots = points
    .map(coverageSnapshot)
    .filter((snapshot): snapshot is CoverageSnapshot => snapshot !== null);
  const firstSnapshot = snapshots[0];
  const lastSnapshot = snapshots.at(-1);
  const coverage = snapshots.length < 2 || !firstSnapshot || !lastSnapshot
    ? null
    : {
      percent: lastSnapshot.percent,
      delta: lastSnapshot.percent - firstSnapshot.percent,
      sinceDate: formatDay(parseDay(firstSnapshot.date)),
    };

  return { points, span, queue, totals, coverage };
}

export const changeLabel = (change: number) =>
  change === 0 ? "no net change" : `${fmt(Math.abs(change))} ${change < 0 ? "fewer" : "more"}`;

export const deltaLabel = (delta: number) =>
  delta === 0 ? "no change" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} pts`;

/** Spoken form of the same delta: "+16 pts" reads badly out loud. */
const spokenDelta = (delta: number) =>
  delta === 0 ? "unchanged" : `${delta > 0 ? "up" : "down"} ${Math.abs(delta)} points`;

/** The chart's text alternative: everything it shows, without colour. */
export function historySummaryText(summary: HistorySummary): string {
  const { span, queue, totals, coverage } = summary;
  if (!span) return "No description history in the selected range.";
  const parts = [
    `Attachment description backlog by day, ${span.from} to ${span.to}.`,
  ];
  parts.push(
    queue
      ? `Backlog ${fmt(queue.latest)} files on ${queue.latestDate}, ` +
        `${changeLabel(queue.change)} than ${fmt(queue.firstDepth)} on ${queue.firstDate}.`
      : "No end-of-day backlog readings recorded in this range.",
  );
  parts.push(
    `Description outcomes in range: ${fmt(totals.described)} described, ${fmt(totals.skipped)} skipped, ` +
      `${fmt(totals.failed)} failed.`,
  );
  if (coverage) {
    parts.push(
      `Coverage ${coverage.percent} percent, ${spokenDelta(coverage.delta)} since ${coverage.sinceDate}.`,
    );
  }
  return parts.join(" ");
}
