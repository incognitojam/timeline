import { describe, expect, it } from "vitest";
import type { AttachmentDescriptionHistoryPoint } from "./api";
import { historySummaryText, summarizeHistory } from "./attachment-description-history";

const NOW = new Date("2026-08-28T09:30:00Z");
/** 44 consecutive days ending on NOW's date start here. */
const START_MS = Date.UTC(2026, 6, 16);

function makePoints(
  count: number,
  overrides: (index: number) => Partial<AttachmentDescriptionHistoryPoint> = () => ({}),
): AttachmentDescriptionHistoryPoint[] {
  return Array.from({ length: count }, (_unused, index) => ({
    date: new Date(START_MS + index * 86_400_000).toISOString().slice(0, 10),
    queueDepth: 5000 - index * 100,
    descriptionEligibleHashes: null,
    describedHashes: null,
    described: 100 + index,
    skipped: 2,
    failed: index % 10 === 0 ? 1 : 0,
    runs: 12,
    failedRuns: 1,
    deferredRuns: 0,
    ...overrides(index),
  }));
}

const snapshots = (byIndex: Record<number, [eligible: number, described: number]>) =>
  makePoints(44, (index) => {
    const snapshot = byIndex[index];
    return snapshot ? { descriptionEligibleHashes: snapshot[0], describedHashes: snapshot[1] } : {};
  });

describe("summarizeHistory", () => {
  it.each([
    {
      name: "90 days keeps the whole 44-day record",
      points: makePoints(44),
      range: "90d" as const,
      days: 44,
      span: { from: "Jul 16", to: "Aug 28, 2026" },
      queue: { latest: 700, latestDate: "Aug 28", firstDepth: 5000, firstDate: "Jul 16", change: -4300 },
      totals: { described: 5346, skipped: 88, failed: 5 },
    },
    {
      name: "30 days counts back from today, today included",
      points: makePoints(44),
      range: "30d" as const,
      days: 30,
      span: { from: "Jul 30", to: "Aug 28, 2026" },
      queue: { latest: 700, latestDate: "Aug 28", firstDepth: 3600, firstDate: "Jul 30", change: -2900 },
      totals: { described: 3855, skipped: 60, failed: 3 },
    },
    {
      name: "a window with only stale days is empty rather than showing them as recent",
      points: makePoints(5),
      range: "30d" as const,
      days: 0,
      span: null,
      queue: null,
      totals: { described: 0, skipped: 0, failed: 0 },
    },
    {
      name: "All keeps stale days",
      points: makePoints(5),
      range: "all" as const,
      days: 5,
      span: { from: "Jul 16", to: "Jul 20, 2026" },
      queue: { latest: 4600, latestDate: "Jul 20", firstDepth: 5000, firstDate: "Jul 16", change: -400 },
      totals: { described: 510, skipped: 10, failed: 1 },
    },
    {
      name: "the latest backlog is the last day with a reading",
      points: makePoints(44, (index) => (index >= 40 ? { queueDepth: null } : {})),
      range: "90d" as const,
      days: 44,
      span: { from: "Jul 16", to: "Aug 28, 2026" },
      queue: { latest: 1100, latestDate: "Aug 24", firstDepth: 5000, firstDate: "Jul 16", change: -3900 },
      totals: { described: 5346, skipped: 88, failed: 5 },
    },
  ])("$name", ({ points, range, days, span, queue, totals }) => {
    const summary = summarizeHistory(points, range, NOW);
    expect(summary.points).toHaveLength(days);
    expect(summary.span).toEqual(span);
    expect(summary.queue).toEqual(queue);
    expect(summary.totals).toEqual(totals);
  });

  it.each([
    { name: "no snapshots", points: makePoints(44), coverage: null },
    { name: "one snapshot", points: snapshots({ 43: [1000, 780] }), coverage: null },
    {
      name: "a snapshot with no eligible files is not a reading",
      points: snapshots({ 42: [0, 0], 43: [1000, 780] }),
      coverage: null,
    },
    {
      name: "two snapshots: the latest and its change since the first",
      points: snapshots({ 20: [900, 450], 42: [1000, 620], 43: [1000, 780] }),
      coverage: { percent: 78, delta: 28, sinceDate: "Aug 5" },
    },
  ])("coverage with $name", ({ points, coverage }) => {
    expect(summarizeHistory(points, "90d", NOW).coverage).toEqual(coverage);
  });
});

describe("historySummaryText", () => {
  it.each([
    {
      name: "a falling backlog and rising coverage",
      points: snapshots({ 42: [1000, 620], 43: [1000, 780] }),
      text:
        "Attachment description backlog by day, Jul 16 to Aug 28, 2026. " +
        "Backlog 700 files on Aug 28, 4,300 fewer than 5,000 on Jul 16. " +
        "Description outcomes in range: 5,346 described, 88 skipped, 5 failed. " +
        "Coverage 78 percent, up 16 points since Aug 27.",
    },
    {
      name: "a flat backlog and falling coverage",
      points: makePoints(3, (index) => ({
        queueDepth: 10,
        descriptionEligibleHashes: 100,
        describedHashes: 50 - index,
      })).map((point, index) => ({ ...point, date: `2026-08-2${6 + index}` })),
      text:
        "Attachment description backlog by day, Aug 26 to Aug 28, 2026. " +
        "Backlog 10 files on Aug 28, no net change than 10 on Aug 26. " +
        "Description outcomes in range: 303 described, 6 skipped, 1 failed. " +
        "Coverage 48 percent, down 2 points since Aug 26.",
    },
    {
      name: "no backlog readings",
      points: makePoints(2, () => ({ queueDepth: null })).map((point, index) => ({
        ...point,
        date: `2026-08-2${7 + index}`,
      })),
      text:
        "Attachment description backlog by day, Aug 27 to Aug 28, 2026. " +
        "No end-of-day backlog readings recorded in this range. " +
        "Description outcomes in range: 201 described, 4 skipped, 1 failed.",
    },
  ])("$name", ({ points, text }) => {
    expect(historySummaryText(summarizeHistory(points, "90d", NOW))).toBe(text);
  });
});
