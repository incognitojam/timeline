import type { EChartsOption } from "echarts";
import { EChartsAutoSize } from "../ui/echarts";
import { createMemo, createSignal, Show } from "solid-js";
import type { AttachmentDescriptionHistoryPoint } from "../lib/api";
import { useChartTheme } from "../lib/echarts-theme";
import { useAttachmentDescriptionHistory } from "../lib/queries";
import SegmentedControl from "../ui/SegmentedControl";

type HistoryRange = "30d" | "90d" | "all";

const RANGE_OPTIONS = [
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
] as const satisfies readonly { value: HistoryRange; label: string }[];

/** Window length in days, counted back from today. `null` = everything recorded. */
const RANGE_DAYS: Record<HistoryRange, number | null> = { "30d": 30, "90d": 90, all: null };

const RANGE_EMPTY: Record<HistoryRange, string> = {
  "30d": "No description runs recorded in the last 30 days.",
  "90d": "No description runs recorded in the last 90 days.",
  all: "No description runs recorded yet.",
};

const DAY_MS = 86_400_000;

/** Series names are the legend, tooltip, and test-facing contract of the chart. */
const SERIES = {
  queue: "Backlog",
  described: "Described",
  skipped: "Skipped",
  failed: "Failed",
} as const;

/**
 * Outcome hues are semantic, not palette-indexed: the generated palette is a
 * single purple family, which made "described" and "failed" nearly identical.
 * These three mid-tones clear 3:1 against both the light and dark card, so one
 * fixed set serves both schemes and keeps the stacked bar readable.
 */
const OUTCOME = {
  described: "#34a08f",
  skipped: "#b8862b",
  failed: "#e0524b",
} as const;

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtCompact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
    .format(n);
}

/** `YYYY-MM-DD` → UTC midnight ms, so day boundaries never drift with the viewer's zone. */
function parseDay(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function formatDay(ms: number, withYear = false): string {
  return new Date(ms).toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" as const } : {}),
  });
}

type Point = AttachmentDescriptionHistoryPoint;

interface CoverageSnapshot {
  date: string;
  percent: number;
}

/** Only exact recorded snapshots count — a null denominator is never reconstructed. */
function coverageSnapshot(point: Point): CoverageSnapshot | null {
  const eligible = point.descriptionEligibleHashes;
  const described = point.describedHashes;
  if (eligible === null || described === null || eligible <= 0) return null;
  return { date: point.date, percent: Math.round((described / eligible) * 100) };
}

/**
 * Long-horizon companion to the per-run queue chart on the sync source page:
 * the daily description backlog line over one stacked bar of daily file
 * outcomes, plus a single coverage reading that only appears once two exact
 * snapshots exist.
 *
 * Every state renders inside its own card so the stats header, filters, and
 * gallery below never wait on this query.
 */
export default function AttachmentDescriptionHistoryCard() {
  const chart = useChartTheme();
  const historyQuery = useAttachmentDescriptionHistory();
  const [range, setRange] = createSignal<HistoryRange>("90d");

  // Only the backlog line follows the generated palette; it repaints with the
  // color scheme, while the outcome hues stay fixed and semantic.
  const queueColor = createMemo(() => chart.palette()[0] ?? "#625690");

  // Guarded like the other queries on this page: never read `data` while the
  // query is pending, so the surrounding Suspense boundary can't be triggered.
  const allPoints = createMemo<Point[]>(() =>
    historyQuery.isPending || historyQuery.isLoadingError ? [] : historyQuery.data?.points ?? []
  );

  // Client-side window over the single all-history response: switching ranges
  // re-slices what is already cached and never issues another request. The
  // window is counted back from today in UTC, matching how the daily points
  // are bucketed, so a stale dataset reads as empty rather than as recent.
  const points = createMemo<Point[]>(() => {
    const recorded = allPoints();
    const days = RANGE_DAYS[range()];
    if (days === null || recorded.length === 0) return recorded;
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const cutoff = today - (days - 1) * DAY_MS;
    return recorded.filter((point) => parseDay(point.date) >= cutoff);
  });

  const queuePoints = createMemo(() => points().filter((point) => point.queueDepth !== null));

  const totals = createMemo(() =>
    points().reduce(
      (acc, point) => ({
        described: acc.described + point.described,
        skipped: acc.skipped + point.skipped,
        failed: acc.failed + point.failed,
      }),
      { described: 0, skipped: 0, failed: 0 },
    )
  );

  const hasQuietDetail = () => totals().skipped > 0 || totals().failed > 0;

  // The header carries one date span and nothing else — the segmented control
  // already states which window is selected.
  const span = createMemo(() => {
    const first = points()[0];
    const last = points().at(-1);
    if (!first || !last) return null;
    return { from: formatDay(parseDay(first.date)), to: formatDay(parseDay(last.date), true) };
  });

  const queueSummary = createMemo(() => {
    const first = queuePoints()[0];
    const last = queuePoints().at(-1);
    if (!first || !last || first.queueDepth === null || last.queueDepth === null) return null;
    return {
      latest: last.queueDepth,
      latestDate: formatDay(parseDay(last.date)),
      firstDepth: first.queueDepth,
      firstDate: formatDay(parseDay(first.date)),
      change: last.queueDepth - first.queueDepth,
    };
  });

  // Coverage stays hidden until two exact snapshots exist in the window, and
  // then reads as one figure plus its movement: the stats header above remains
  // the live source of truth for the current percentage.
  const coverage = createMemo(() => {
    const snapshots = points()
      .map(coverageSnapshot)
      .filter((snapshot): snapshot is CoverageSnapshot => snapshot !== null);
    const first = snapshots[0];
    const last = snapshots.at(-1);
    if (snapshots.length < 2 || !first || !last) return null;
    return {
      percent: last.percent,
      delta: last.percent - first.percent,
      sinceDate: formatDay(parseDay(first.date)),
    };
  });

  const changeLabel = (change: number) =>
    change === 0 ? "no net change" : `${fmt(Math.abs(change))} ${change < 0 ? "fewer" : "more"}`;

  const deltaLabel = (delta: number) =>
    delta === 0 ? "no change" : `${delta > 0 ? "+" : "−"}${Math.abs(delta)} pts`;

  /** Spoken form of the same delta: "+16 pts" reads badly out loud. */
  const spokenDelta = (delta: number) =>
    delta === 0 ? "unchanged" : `${delta > 0 ? "up" : "down"} ${Math.abs(delta)} points`;

  const headerFallback = () => {
    if (historyQuery.isLoadingError) return "History unavailable";
    if (historyQuery.isPending) return "Daily backlog and outcomes";
    return "No recorded days";
  };

  const chartSummary = () => {
    const recorded = span();
    const queue = queueSummary();
    const t = totals();
    if (!recorded) return "No description history in the selected range.";
    const parts = [
      `Attachment description backlog by day, ${recorded.from} to ${recorded.to}.`,
    ];
    parts.push(
      queue
        ? `Backlog ${fmt(queue.latest)} files on ${queue.latestDate}, ` +
          `${changeLabel(queue.change)} than ${fmt(queue.firstDepth)} on ${queue.firstDate}.`
        : "No end-of-day backlog readings recorded in this range.",
    );
    parts.push(
      `Description outcomes in range: ${fmt(t.described)} described, ${fmt(t.skipped)} skipped, ` +
        `${fmt(t.failed)} failed.`,
    );
    const cov = coverage();
    if (cov) {
      parts.push(
        `Coverage ${cov.percent} percent, ${spokenDelta(cov.delta)} since ${cov.sinceDate}.`,
      );
    }
    return parts.join(" ");
  };

  const chartOption = createMemo((): EChartsOption | null => {
    const data = points();
    if (data.length === 0) return null;

    const line = queueColor();
    const firstDay = parseDay(data[0].date);
    const lastDay = parseDay(data[data.length - 1].date);

    const byTime = new Map<number, Point>();
    for (const point of data) byTime.set(parseDay(point.date), point);

    // One bar per day, three stacked segments, no rounding: the segment
    // boundaries are the only thing that has to read at a glance.
    const outcomeSeries = (name: string, color: string, pick: (point: Point) => number) => ({
      name,
      type: "bar" as const,
      stack: "outcomes",
      yAxisIndex: 1,
      barMaxWidth: 12,
      z: 1,
      itemStyle: { color },
      data: data.map((point) => [parseDay(point.date), pick(point)] as [number, number]),
    });

    return {
      baseOption: {
        animation: false,
        grid: { top: 12, right: 8, bottom: 4, left: 4, containLabel: true },
        // The visible legend is the HTML strip above the canvas: ECharts'
        // scroll legend paginated ("1/3") and clipped labels at phone widths.
        legend: { show: false },
        tooltip: {
          trigger: "axis",
          confine: true,
          axisPointer: { type: "line", snap: true },
          formatter: (params: unknown) => {
            const list = Array.isArray(params) ? params : [params];
            const head = list[0] as { axisValue?: number | string } | undefined;
            const point = head === undefined ? undefined : byTime.get(Number(head.axisValue));
            if (!point) return "";
            const lines = [`<strong>${formatDay(parseDay(point.date), true)}</strong>`];
            lines.push(
              point.queueDepth === null
                ? "No backlog reading"
                : `${SERIES.queue}: ${fmt(point.queueDepth)} files`,
            );
            lines.push(
              `${fmt(point.described)} described · ${fmt(point.skipped)} skipped · ` +
                `${fmt(point.failed)} failed`,
            );
            // Run detail is noise on a clean day, so it only shows up when
            // something actually needs attention.
            const runNotes = [
              point.failedRuns > 0 ? `${fmt(point.failedRuns)} failed` : null,
              point.deferredRuns > 0 ? `${fmt(point.deferredRuns)} deferred` : null,
            ].filter((note): note is string => note !== null);
            lines.push(
              runNotes.length === 0
                ? `${fmt(point.runs)} runs`
                : `${fmt(point.runs)} runs · ${runNotes.join(" · ")}`,
            );
            const snapshot = coverageSnapshot(point);
            if (snapshot) lines.push(`Coverage: ${snapshot.percent}%`);
            return lines.join("<br/>");
          },
        },
        xAxis: {
          type: "time",
          // ECharts already leaves room for the edge bars. A percentage gap
          // grows into multiple empty days in the longer ranges.
          min: firstDay,
          max: lastDay,
          // Never tick finer than a day, and let ECharts drop any label that
          // would touch a neighbour instead of stacking them.
          minInterval: DAY_MS,
          splitNumber: 5,
          axisLabel: {
            fontSize: 10,
            hideOverlap: true,
            formatter: (value: number) => formatDay(value),
          },
        },
        // Axis roles are named by the legend strip; the canvas carries no axis
        // name text to collide at any width.
        yAxis: [
          {
            type: "value",
            min: 0,
            minInterval: 1,
            axisLabel: { fontSize: 10, formatter: (value: number) => fmtCompact(value) },
          },
          {
            type: "value",
            min: 0,
            minInterval: 1,
            splitLine: { show: false },
            axisLabel: { fontSize: 10, formatter: (value: number) => fmtCompact(value) },
          },
        ],
        series: [
          outcomeSeries(SERIES.described, OUTCOME.described, (point) => point.described),
          outcomeSeries(SERIES.skipped, OUTCOME.skipped, (point) => point.skipped),
          outcomeSeries(SERIES.failed, OUTCOME.failed, (point) => point.failed),
          {
            name: SERIES.queue,
            type: "line",
            data: data.map((point) =>
              [parseDay(point.date), point.queueDepth] as [number, number | null]
            ),
            connectNulls: false,
            showSymbol: data.length <= 45,
            symbol: "circle",
            symbolSize: 4,
            z: 3,
            lineStyle: { width: 2 },
            itemStyle: { color: line },
          },
        ],
      },
      media: [
        {
          // ECharts evaluates this against the chart container (re-checked on
          // every resize), so a ~313px plot inside a phone-width card gets
          // roughly 3–5 date ticks instead of the full dense sequence.
          query: { maxWidth: 480 },
          option: { xAxis: { splitNumber: 3 } },
        },
      ],
    };
  });

  const hasCard = () =>
    historyQuery.isPending || historyQuery.isLoadingError || allPoints().length > 0;

  return (
    <Show when={hasCard()}>
      <section
        class="mb-6 rounded-lg border border-border bg-card p-4"
        aria-labelledby="attachment-history-heading"
      >
        <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div class="min-w-0">
            <h2
              id="attachment-history-heading"
              class="text-[11px] uppercase tracking-wide text-muted-foreground"
            >
              Description backlog
            </h2>
            <p class="mt-0.5 text-xs text-muted-foreground">
              <Show when={span()} fallback={headerFallback()}>
                {(recorded) => (
                  <span class="font-mono">{recorded().from} – {recorded().to}</span>
                )}
              </Show>
            </p>
          </div>
          <SegmentedControl
            label="History range"
            options={RANGE_OPTIONS}
            value={range()}
            onChange={setRange}
            class="shrink-0"
          />
        </div>

        {/* Loading: a quiet placeholder that never blocks the gallery below. */}
        <Show when={historyQuery.isPending}>
          <div
            class="mt-3 h-40 animate-pulse rounded-md bg-accent/60 motion-reduce:animate-none sm:h-48"
            aria-busy="true"
            aria-label="Loading description history"
          />
        </Show>

        {/* Error: inline and recoverable, never a page-level failure. */}
        <Show when={historyQuery.isLoadingError}>
          <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span>Could not load description history.</span>
            <button
              type="button"
              class="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={() => void historyQuery.refetch()}
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={historyQuery.isRefetchError}>
          <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" role="status">
            <span>Could not refresh; showing saved history.</span>
            <button
              type="button"
              class="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={() => void historyQuery.refetch()}
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={!historyQuery.isPending && !historyQuery.isLoadingError}>
          <Show
            when={chartOption()}
            fallback={
              <p class="mt-3 rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
                {RANGE_EMPTY[range()]}
                <Show when={range() !== "all"}> Switch to All to see everything.</Show>
              </p>
            }
          >
            {(option) => (
              <>
                {/* Two headline numbers only. Skipped and failed stay on
                    one quiet line, and only when they are non-zero. */}
                <div class="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                  <div class="flex flex-wrap gap-x-6 gap-y-2">
                    <Show
                      when={queueSummary()}
                      fallback={<Metric label="Latest backlog" value="—" hint="no readings" />}
                    >
                      {(queue) => (
                        <Metric
                          label="Latest backlog"
                          value={fmt(queue().latest)}
                          hint={`${queue().latestDate} · ${changeLabel(queue().change)} than ${queue().firstDate}`}
                        />
                      )}
                    </Show>
                    <Metric label="Descriptions added" value={fmt(totals().described)} />
                  </div>
                  <Show when={hasQuietDetail()}>
                    <p class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <Show when={totals().skipped > 0}>
                        <span>{fmt(totals().skipped)} skipped</span>
                      </Show>
                      <Show when={totals().failed > 0}>
                        <span style={{ color: OUTCOME.failed }}>
                          {fmt(totals().failed)} failed
                        </span>
                      </Show>
                    </p>
                  </Show>
                </div>

                {/* One plain legend row. The three outcome hues are previewed
                    as a single miniature stacked bar so their relationship on
                    the canvas is obvious without a caption. Hidden from AT:
                    the chart's aria-label carries the full non-color meaning. */}
                <div
                  class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-tight text-muted-foreground"
                  aria-hidden="true"
                >
                  <span class="flex items-center gap-1.5">
                    <span
                      class="h-0.5 w-3.5 shrink-0 rounded-full"
                      style={{ "background-color": queueColor() }}
                    />
                    Backlog
                  </span>
                  <span class="flex items-center gap-2">
                    <span class="flex h-3.5 w-2 shrink-0 flex-col overflow-hidden rounded-[2px]">
                      <span class="flex-1" style={{ "background-color": OUTCOME.failed }} />
                      <span class="flex-1" style={{ "background-color": OUTCOME.skipped }} />
                      <span class="flex-[3]" style={{ "background-color": OUTCOME.described }} />
                    </span>
                    <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <LegendSwatch color={OUTCOME.described} label="Described" />
                      <LegendSwatch color={OUTCOME.skipped} label="Skipped" />
                      <LegendSwatch color={OUTCOME.failed} label="Failed" />
                    </span>
                  </span>
                </div>

                <div class="mt-2 h-40 sm:h-48" role="img" aria-label={chartSummary()}>
                  <EChartsAutoSize option={chart.option(option())} />
                </div>

                {/* Exact coverage only, as one figure and its movement. Fewer
                    than two recorded snapshots renders nothing at all. */}
                <Show when={coverage()}>
                  {(cov) => (
                    <div class="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
                      <span class="uppercase tracking-wide">Eligible described</span>
                      <span class="font-mono text-sm text-foreground">{cov().percent}%</span>
                      <span>{deltaLabel(cov().delta)} since {cov().sinceDate}</span>
                    </div>
                  )}
                </Show>
              </>
            )}
          </Show>
        </Show>
      </section>
    </Show>
  );
}

function LegendSwatch(props: { color: string; label: string }) {
  return (
    <span class="flex items-center gap-1.5">
      <span
        class="h-2 w-2 shrink-0 rounded-[2px]"
        style={{ "background-color": props.color }}
      />
      {props.label}
    </span>
  );
}

function Metric(props: { label: string; value: string; hint?: string }) {
  return (
    <div class="flex flex-col">
      <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{props.label}</span>
      <span class="font-mono text-base leading-tight text-foreground">{props.value}</span>
      <Show when={props.hint}>
        <span class="text-[11px] text-muted-foreground">{props.hint}</span>
      </Show>
    </div>
  );
}
