import {
  canShiftHealthWindowForward,
  formatHealthDateOnly,
  type HealthDateRange,
  type HealthWindow,
  type HealthWindowView,
  parseHealthDateOnly,
  parseHealthWindow,
  resolveHealthWindow,
  selectHealthWindow,
  shiftHealthWindow,
} from "@shared/health-periods";
import { useSearchParams } from "@solidjs/router";
import type { EChartsOption } from "echarts";
import { DateChart, dateChartMinWidth } from "../ui/date-chart";
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js";
import {
  type BiomarkerData,
  type BiomarkerReferenceRange,
  type PreviousPeriodStats,
} from "../lib/api";
import { useChartTheme } from "../lib/echarts-theme";
import {
  formatEfficiency,
  formatHeartRate,
  formatHRV,
  formatSleepDuration,
  formatSpO2,
  formatSteps,
  formatTimeOfDay,
  formatWeight,
  getBiomarkerLevelColor,
  getSleepScoreChartColor,
  getSleepScoreColor,
  getSleepScoreLabel,
  niceAxisBounds,
  normalizeRangePosition,
  referenceRangeExtent,
  sortReferenceRanges,
} from "../lib/health-utils";
import { useHealthBiomarkers, useHealthStats } from "../lib/queries";
import { normalizeRouteParam } from "../lib/route-params";
import { staleContentClass } from "../lib/stale-content";
import { IconChevronLeft, IconChevronRight, IconSettingsBackupRestore } from "../ui/icons";
import SegmentedControl from "../ui/SegmentedControl";
import BiomarkerDetailModal from "./BiomarkerDetailModal";

export type View = Extract<HealthWindowView, "week" | "month" | "year">;
type DashboardHealthWindow = Omit<HealthWindow, "view"> & { view: View };

const CHART_GROUP_CLASS = "flex flex-wrap gap-4 [&>div]:min-w-0 [&>div]:grow [&>div]:basis-[max(var(--chart-card-min-width),calc(50%_-_0.5rem))]";

const VIEWS: { value: View; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

function isDashboardView(view: HealthWindowView): view is View {
  return VIEWS.some(option => option.value === view);
}

// ============================================================================
// Period Title Formatting
// ============================================================================

/**
 * Generate a human-readable title for the current period
 */
export function getPeriodTitle(
  view: View,
  mode: HealthWindow["mode"],
  start: string | null,
  end: string | null,
  locale?: Intl.LocalesArgument
): string {
  if (!start || !end) return "";

  const startDate = parseHealthDateOnly(start);
  const endDate = parseHealthDateOnly(end);

  const formatDayRange = () => {
    const currentYear = new Date().getFullYear();
    const startDay = startDate.getDate();
    const endDay = endDate.getDate();
    const startMonth = startDate.toLocaleDateString(locale, { month: "short" });
    const endMonth = endDate.toLocaleDateString(locale, { month: "short" });
    const startYear = startDate.getFullYear();
    const endYear = endDate.getFullYear();

    if (startYear !== endYear) {
      return `${startDay} ${startMonth} ${startYear} - ${endDay} ${endMonth} ${endYear}`;
    }
    if (startDate.getMonth() !== endDate.getMonth()) {
      return startYear === currentYear
        ? `${startDay} ${startMonth} - ${endDay} ${endMonth}`
        : `${startDay} ${startMonth} - ${endDay} ${endMonth} ${startYear}`;
    }
    return startYear === currentYear
      ? `${startDay} - ${endDay} ${startMonth}`
      : `${startDay} - ${endDay} ${startMonth} ${startYear}`;
  };

  if (view === "week") {
    return formatDayRange();
  }

  if (view === "month") {
    if (mode === "recent") return formatDayRange();
    // Format: "October 2025" or just "October" if current year
    const currentYear = new Date().getFullYear();
    const monthName = startDate.toLocaleDateString(locale, { month: "long" });
    const year = startDate.getFullYear();
    if (year === currentYear) return monthName;
    return `${monthName} ${year}`;
  }

  if (view === "year") {
    if (mode === "recent") {
      const startMonth = startDate.toLocaleDateString(locale, { month: "short" });
      const endMonth = endDate.toLocaleDateString(locale, { month: "short" });
      return `${startMonth} ${startDate.getFullYear()} - ${endMonth} ${endDate.getFullYear()}`;
    }
    return String(startDate.getFullYear());
  }

  return "";
}

// ============================================================================
// Comparison Formatting
// ============================================================================

/**
 * Format comparison text for stats
 */
export function formatComparison(
  current: number,
  previous: number | undefined,
  periodLabel: View | "period",
  options?: {
    unit?: string;
    formatter?: (n: number) => string;
    lowerIsBetter?: boolean;
  }
): string | null {
  if (previous === undefined || previous === 0) return null;

  const diff = current - previous;
  if (Math.abs(diff) < 0.01) {
    return `same as the previous ${periodLabel}`;
  }

  const formatter = options?.formatter || ((n: number) => Math.abs(n).toFixed(1));
  const unit = options?.unit || "";
  const direction = diff > 0 ? "higher than" : "lower than";

  return `${formatter(diff)}${unit} ${direction} the previous ${periodLabel}`;
}

/**
 * Format sleep duration comparison (uses "more/less" instead of "higher/lower")
 */
export function formatSleepDurationComparison(
  currentMs: number,
  previousMs: number | undefined,
  periodLabel: View | "period"
): string | null {
  if (previousMs === undefined || previousMs === 0) return null;

  const diff = currentMs - previousMs;
  const diffMins = Math.round(Math.abs(diff) / 60000);
  if (diffMins === 0) {
    return `same as the previous ${periodLabel}`;
  }

  const direction = diff > 0 ? "more than" : "less than";
  return `${diffMins} min ${direction} the previous ${periodLabel}`;
}

type Section = "overview" | "sleep" | "heart" | "activity" | "biomarkers" | "weight";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "sleep", label: "Sleep" },
  { value: "heart", label: "Heart" },
  { value: "activity", label: "Activity" },
  { value: "biomarkers", label: "Biomarkers" },
  { value: "weight", label: "Weight" },
];


// Format date for display
function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Biomarker range indicator component
function BiomarkerRangeIndicator(props: {
  value: number;
  unit: string;
  level: string;
  referenceRanges: BiomarkerReferenceRange[];
}) {
  // Sort ranges by lower_bound to get them in order
  const sortedRanges = () => sortReferenceRanges(props.referenceRanges);

  // Calculate the full range extent for positioning
  const rangeExtent = () => referenceRangeExtent(sortedRanges());

  // Calculate marker position as percentage
  const markerPosition = () => {
    const { min, max } = rangeExtent();
    return normalizeRangePosition(props.value, min, max) * 100;
  };

  // Get marker color based on level
  const markerColor = () => {
    switch (props.level) {
      case "optimal": return "bg-green-500";
      case "normal": return "bg-blue-500";
      case "abnormal": return "bg-yellow-500";
      case "highly_abnormal": return "bg-red-500";
      default: return "bg-gray-500";
    }
  };

  // Get level color for the range zones
  const getZoneColor = (level: string) => {
    switch (level) {
      case "optimal": return "bg-green-500/20";
      case "normal": return "bg-blue-500/20";
      case "abnormal": return "bg-yellow-500/20";
      case "highly_abnormal": return "bg-red-500/20";
      default: return "bg-gray-500/20";
    }
  };

  return (
    <div class="mt-2">
      {/* Range bar */}
      <div class="relative h-2 bg-muted rounded-full overflow-hidden flex">
        <For each={sortedRanges()}>
          {(range) => {
            const { min, max } = rangeExtent();
            const totalRange = max - min;
            const rangeStart = range.lower_bound ?? min;
            const rangeEnd = range.upper_bound ?? max;
            const width = ((rangeEnd - rangeStart) / totalRange) * 100;

            return (
              <div
                class={`h-full ${getZoneColor(range.level)}`}
                style={{ width: `${width}%` }}
                title={`${range.name}: ${range.lower_bound ?? '<'} - ${range.upper_bound ?? '>'}`}
              />
            );
          }}
        </For>
        {/* Value marker */}
        <div
          class={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full ${markerColor()} border-2 border-background shadow-sm`}
          style={{ left: `calc(${markerPosition()}% - 6px)` }}
        />
      </div>
    </div>
  );
}

const validSections = new Set<Section>(["overview", "sleep", "heart", "activity", "biomarkers", "weight"]);

// ============================================================================
// URL Period Parsing and Building
// ============================================================================

export type ParsedPeriod = HealthWindow;

export function getPeriodDateRange(period: ParsedPeriod): HealthDateRange {
  return period.range;
}

function today(): string {
  return formatHealthDateOnly(new Date());
}

function getDefaultUrlPeriod(): DashboardHealthWindow {
  const window = resolveHealthWindow({ view: "month", mode: "recent", anchor: today() });
  return { ...window, view: "month" };
}

/**
 * Parse URL search params to determine view and period
 */
export function parseUrlPeriod(params: Record<string, string | string[] | undefined>): ParsedPeriod {
  return resolveUrlPeriod(params);
}

function resolveUrlPeriod(
  params: Record<string, string | string[] | undefined>
): DashboardHealthWindow {
  const canonical = parseHealthWindow({
    view: normalizeRouteParam(params.view),
    mode: normalizeRouteParam(params.mode),
    anchor: normalizeRouteParam(params.anchor),
  });
  if (canonical && isDashboardView(canonical.view)) {
    return { ...canonical, view: canonical.view };
  }

  return getDefaultUrlPeriod();
}

export default function HealthDashboard() {
  const chart = useChartTheme();
  const [searchParams, setSearchParams] = useSearchParams();

  // Parse period from URL
  const period = () => resolveUrlPeriod(searchParams);
  const view = () => period().view;
  const comparisonPeriodLabel = (): View | "period" =>
    displayedPeriod().mode === "recent" ? "period" : displayedPeriod().view;
  const periodTitle = createMemo(() => {
    const resolved = period();
    return getPeriodTitle(view(), resolved.mode, resolved.range.start, resolved.range.end);
  });

  // Get initial section from URL
  const initialSection = (): Section => {
    const s = normalizeRouteParam(searchParams.section);
    return validSections.has(s as Section) ? (s as Section) : "overview";
  };

  const [section, setSectionInternal] = createSignal<Section>(initialSection());
  const [selectedBiomarker, setSelectedBiomarker] = createSignal<BiomarkerData | null>(null);
  const statsQuery = useHealthStats(period);
  const biomarkersQuery = useHealthBiomarkers();

  // Reading pending Solid Query data suspends. Keep dashboard-level pending and
  // error states local by only touching data once the corresponding query has it.
  const stats = () =>
    statsQuery.isPending || statsQuery.isLoadingError ? null : statsQuery.data?.stats ?? null;
  const displayedPeriod = () => {
    const result = statsQuery.data;
    if (!result) throw new Error("Displayed health period requires loaded stats");
    return result.window;
  };
  const chartCardMinWidth = () => {
    const s = stats();
    if (!s) return 480;
    const count = Math.max(s.sleep.byDay.length, s.heart.byDay.length, s.hrv.byDay.length, s.activity.byDay.length, s.weight.byDay.length);
    return Math.max(480, dateChartMinWidth(count, displayedPeriod().view) + 32);
  };
  const biomarkers = () =>
    biomarkersQuery.isPending || biomarkersQuery.isLoadingError
      ? []
      : biomarkersQuery.data?.biomarkers ?? [];

  const setWindow = (window: HealthWindow) => {
    const selection = selectHealthWindow(window);
    setSearchParams({ ...selection }, { replace: true });
  };

  // Keep links deterministic while migrating existing week/month/year URLs.
  createEffect(() => {
    const selection = selectHealthWindow(period());
    const needsCanonicalUrl =
      normalizeRouteParam(searchParams.view) !== selection.view ||
      normalizeRouteParam(searchParams.mode) !== selection.mode ||
      normalizeRouteParam(searchParams.anchor) !== selection.anchor;

    if (needsCanonicalUrl) setWindow(period());
  });

  // Switching views returns to the recent window for that resolution.
  const setView = (v: View) => {
    setWindow(resolveHealthWindow({ view: v, mode: "recent", anchor: today() }));
  };

  // Wrapper to sync section changes to URL
  const setSection = (s: Section) => {
    setSectionInternal(s);
    setSearchParams({ section: s === "overview" ? undefined : s }, { replace: true });
  };

  // Sync URL back to section (for browser back/forward)
  createEffect(on(() => searchParams.section, (urlSection) => {
    const s = normalizeRouteParam(urlSection);
    const newSection = validSections.has(s as Section) ? (s as Section) : "overview";
    if (newSection !== section()) {
      setSectionInternal(newSection);
    }
  }));

  // Navigation helpers
  const goToPrevious = () => {
    setWindow(shiftHealthWindow(period(), -1));
  };

  const goToNext = () => {
    setWindow(shiftHealthWindow(period(), 1));
  };

  const resetWindow = () => {
    setWindow(resolveHealthWindow({ view: view(), mode: "recent", anchor: today() }));
  };

  const canGoNext = () => canShiftHealthWindowForward(period(), today());
  const canReset = () => period().mode === "calendar";

  // Sleep duration chart (main sleep with naps stacked on top)
  const sleepChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.sleep.byDay.length === 0) return null;

    const isYearView = displayedPeriod().view === "year";
    // In year view byDay entries are monthly (YYYY-MM-15); naps stay daily, so
    // bucket both by month to line them up. Otherwise match on the exact day.
    const bucketOf = (date: string) => (isYearView ? date.slice(0, 7) : date);

    const napTotalByBucket = new Map<string, number>();
    for (const nap of s.sleep.naps) {
      const bucket = bucketOf(nap.date);
      napTotalByBucket.set(bucket, (napTotalByBucket.get(bucket) ?? 0) + nap.duration);
    }
    const napData = s.sleep.byDay.map(d => napTotalByBucket.get(bucketOf(d.date)) ?? 0);
    const hasNaps = napData.some(v => v > 0);

    const napColor = chart.palette()[5];
    const sleepColor = chart.palette()[0];

    return {
      ...(hasNaps
        ? { legend: { data: ["Sleep", "Naps"], top: 0, textStyle: { fontSize: 11 } } }
        : {}),
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const items = params as { axisValue: string; seriesName: string; value: number }[];
          const first = items[0];
          if (!first) return "";
          const lines = items
            .filter(i => i.value > 0)
            .map(i => `${i.seriesName}: ${formatSleepDuration(i.value)}`);
          return `${first.axisValue}<br/>${lines.join("<br/>")}`;
        },
      },
      grid: hasNaps ? { top: 28 } : undefined,
      xAxis: {
        type: "category",
        data: s.sleep.byDay.map(d => d.date),
      },
      yAxis: (() => {
        // Base the axis on the stacked total (main sleep + naps) per category.
        const maxHours = Math.max(...s.sleep.byDay.map((d, i) => d.duration + napData[i])) / 3600000;
        // Compute nice step and max directly (min is always 0, so no padding needed on min side)
        const rawStep = maxHours / 5;
        const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
        const norm = rawStep / mag;
        const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
        const max = Math.ceil(maxHours / step) * step;
        return {
          type: "value" as const,
          axisLabel: {
            formatter: (value: number) => `${Math.round(value / 3600000)}h`,
          },
          min: 0,
          max: max * 3600000,
          interval: step * 3600000,
        };
      })(),
      series: [
        {
          name: "Sleep",
          type: "bar",
          stack: "duration",
          data: s.sleep.byDay.map(d => d.duration),
          itemStyle: { color: sleepColor },
          barMaxWidth: 50,
        },
        ...(hasNaps
          ? [{
              name: "Naps",
              type: "bar" as const,
              stack: "duration",
              data: napData,
              itemStyle: { color: napColor },
              barMaxWidth: 50,
            }]
          : []),
      ],
    };
  };

  // Sleep schedule chart (bedtime → wake time floating bars, naps overlaid)
  const sleepScheduleChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s) return null;

    const isYearView = displayedPeriod().view === "year";

    // Extract fractional hours from ISO timestamp string directly to preserve
    // the original timezone's wall clock time (avoids Date converting to browser timezone).
    const toHours = (iso: string) => {
      return parseInt(iso.slice(11, 13), 10) + parseInt(iso.slice(14, 16), 10) / 60;
    };
    // Bedtime→wake on a continuous scale: an overnight span (bed later than
    // wake) shifts wake past 24 so the bar stays continuous.
    const toSpan = (start: string, end: string) => {
      const bed = toHours(start);
      let wake = toHours(end);
      if (bed > wake) wake += 24;
      return { bed, wake };
    };

    // Main sleep: one span per night that carries both endpoints.
    const mainByDate = new Map<string, { bed: number; wake: number }>();
    for (const d of s.sleep.byDay) {
      if (d.startTime && d.endTime) mainByDate.set(d.date, toSpan(d.startTime, d.endTime));
    }

    // Naps: daily entries only make sense against the daily category axis, so
    // they are omitted from the (monthly) year view. Multiple naps per date are
    // grouped into per-date slots rendered as parallel stacked series.
    const napsByDate = new Map<string, { bed: number; wake: number }[]>();
    if (!isYearView) {
      for (const nap of s.sleep.naps) {
        if (!nap.startTime || !nap.endTime) continue;
        const span = toSpan(nap.startTime, nap.endTime);
        const existing = napsByDate.get(nap.date);
        if (existing) existing.push(span);
        else napsByDate.set(nap.date, [span]);
      }
    }
    const maxNapSlots = Math.max(0, ...Array.from(napsByDate.values(), n => n.length));
    const hasNaps = maxNapSlots > 0;

    // Category axis = union of dates with a main span or any nap.
    const dates = Array.from(new Set([...mainByDate.keys(), ...napsByDate.keys()])).sort();
    if (dates.length === 0) return null;

    // Axis bounds across every span (main + naps).
    const allSpans = [...mainByDate.values(), ...Array.from(napsByDate.values()).flat()];
    const yMin = Math.floor(Math.min(...allSpans.map(v => v.bed)));
    const yMax = Math.ceil(Math.max(...allSpans.map(v => v.wake)));

    const sleepColor = chart.palette()[3];
    const napColor = chart.palette()[5];

    // A transparent base pushes each visible bar up to its start hour; missing
    // entries use "-" so ECharts leaves that category empty. Each call uses its
    // own stack (so sleep and naps don't sum together), but barGap: "-100%"
    // below makes every stack's column overlap rather than sit side by side.
    type SeriesItem = Extract<NonNullable<EChartsOption["series"]>, readonly unknown[]>[number];
    const floatingPair = (
      stack: string,
      color: string,
      name: string,
      span: (date: string) => { bed: number; wake: number } | undefined,
    ): SeriesItem[] => [
      {
        type: "bar",
        stack,
        data: dates.map(d => span(d)?.bed ?? "-"),
        itemStyle: { color: "transparent" },
        barMaxWidth: 50,
        barGap: "-100%",
        emphasis: { itemStyle: { color: "transparent" } },
        tooltip: { show: false },
        silent: true,
      },
      {
        name,
        type: "bar",
        stack,
        data: dates.map(d => {
          const v = span(d);
          return v ? v.wake - v.bed : "-";
        }),
        itemStyle: { color },
        barMaxWidth: 50,
        barGap: "-100%",
      },
    ];

    const series: SeriesItem[] = [
      ...floatingPair("schedule", sleepColor, "Sleep", d => mainByDate.get(d)),
    ];
    for (let slot = 0; slot < maxNapSlots; slot++) {
      series.push(
        ...floatingPair(`nap-${slot}`, napColor, "Naps", d => napsByDate.get(d)?.[slot]),
      );
    }

    return {
      ...(hasNaps
        ? { legend: { data: ["Sleep", "Naps"], top: 0, textStyle: { fontSize: 11 } } }
        : {}),
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const items = params as { axisValue: string }[];
          const date = items?.[0]?.axisValue;
          if (!date) return "";
          const lines: string[] = [date];
          const main = mainByDate.get(date);
          if (main) lines.push(`Bedtime: ${formatTimeOfDay(main.bed)}<br/>Wake: ${formatTimeOfDay(main.wake)}`);
          const naps = napsByDate.get(date);
          if (naps) {
            for (const nap of naps) {
              lines.push(`Nap: ${formatTimeOfDay(nap.bed)}–${formatTimeOfDay(nap.wake)}`);
            }
          }
          return lines.join("<br/>");
        },
      },
      grid: hasNaps ? { top: 28 } : undefined,
      xAxis: {
        type: "category",
        data: dates,
      },
      yAxis: {
        type: "value",
        min: yMin,
        max: yMax,
        axisLabel: {
          formatter: (value: number) => formatTimeOfDay(value),
        },
      },
      series,
    };
  };

  // Sleep score chart
  const sleepScoreChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.sleep.byDay.length === 0) return null;

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const p = (params as { axisValue: string; value: number }[])[0];
          return `${p.axisValue}: ${Math.round(p.value)} (${getSleepScoreLabel(p.value)})`;
        },
      },
      xAxis: {
        type: "category",
        data: s.sleep.byDay.map(d => d.date),
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: { formatter: (value: number) => `${value}` },
      },
      series: [
        {
          type: "bar",
          data: s.sleep.byDay.map(d => ({
            value: d.score,
            itemStyle: { color: getSleepScoreChartColor(d.score) },
          })),
          barMaxWidth: 50,
        },
      ],
    };
  };

  // Heart Rate chart (with rolling personal range band)
  const heartRateChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.heart.byDay.length === 0) return null;

    const dates = s.heart.byDay.map(d => d.date);
    const rollingBaseline = s.heart.rollingBaseline || [];
    const baselineMap = new Map(rollingBaseline.map(b => [b.date, b]));

    const series: EChartsOption["series"] = [];

    // Add baseline band if we have rolling baseline data
    // Use custom series to draw filled rectangles with dashed lines only at top/bottom
    if (rollingBaseline.length > 0) {
      series.push({
        name: "baseline-band",
        type: "custom",
        renderItem: (params, api) => {
          const categoryIndex = api.value(0) as number;
          const lowerBound = api.value(1) as number | null;
          const upperBound = api.value(2) as number | null;

          if (lowerBound == null || upperBound == null) return undefined;

          const lowCoord = api.coord([categoryIndex, lowerBound]);
          const highCoord = api.coord([categoryIndex, upperBound]);
          const sizeResult = api.size?.([1, 0]);
          const bandWidth = Array.isArray(sizeResult) ? sizeResult[0] : (sizeResult ?? 0);

          // With boundaryGap: true, data points are centered in their slots
          // Band spans from left edge to right edge of the slot (no gaps)
          const centerX = lowCoord[0];
          const x = centerX - bandWidth / 2;
          const width = bandWidth;

          return {
            type: "group",
            children: [
              // Filled rectangle
              {
                type: "rect",
                shape: { x, y: highCoord[1], width, height: lowCoord[1] - highCoord[1] },
                style: { fill: chart.palette()[2], opacity: 0.2 },
              },
              // Top dashed line
              {
                type: "line",
                shape: { x1: x, y1: highCoord[1], x2: x + width, y2: highCoord[1] },
                style: { stroke: chart.palette()[2], lineWidth: 1, lineDash: [4, 2] },
              },
              // Bottom dashed line
              {
                type: "line",
                shape: { x1: x, y1: lowCoord[1], x2: x + width, y2: lowCoord[1] },
                style: { stroke: chart.palette()[2], lineWidth: 1, lineDash: [4, 2] },
              },
            ],
          };
        },
        data: dates.map((date, i) => {
          const b = baselineMap.get(date);
          return [i, b?.lowerBound ?? null, b?.upperBound ?? null];
        }),
        silent: true,
        tooltip: { show: false },
        z: 1,
      });
    }

    // Main data line (on top)
    series.push({
      name: "Resting HR",
      type: "line",
      data: s.heart.byDay.map(d => d.restingHR),
      smooth: false,
      showSymbol: false,
      itemStyle: { color: chart.palette()[5] },
      z: 10,
    });

    // Calculate axis bounds including both data and baseline range
    const dataValues = s.heart.byDay.map(d => d.restingHR).filter((v): v is number => v != null);
    const baselineLows = rollingBaseline.map(b => b.lowerBound).filter((v): v is number => v != null);
    const baselineHighs = rollingBaseline.map(b => b.upperBound).filter((v): v is number => v != null);
    const allValues = [...dataValues, ...baselineLows, ...baselineHighs];
    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues);
    const { min: axisMin, max: axisMax } = niceAxisBounds(dataMin, dataMax);

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const items = params as { seriesName: string; axisValue: string; value: number }[];
          const main = items.find(p => p.seriesName === "Resting HR");
          return main ? `${main.axisValue}: ${formatHeartRate(main.value)}` : "";
        },
      },
      xAxis: {
        type: "category",
        data: dates,
      },
      yAxis: {
        type: "value",
        axisLabel: {
          formatter: (value: number) => `${Math.round(value)}`,
        },
        min: axisMin,
        max: axisMax,
      },
      series,
    };
  };

  // HRV chart (with rolling personal range band)
  const hrvChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.hrv.byDay.length === 0) return null;

    const dates = s.hrv.byDay.map(d => d.date);
    const rollingBaseline = s.hrv.rollingBaseline || [];
    const baselineMap = new Map(rollingBaseline.map(b => [b.date, b]));

    const series: EChartsOption["series"] = [];

    // Add baseline band if we have rolling baseline data
    // Use custom series to draw filled rectangles with dashed lines only at top/bottom
    if (rollingBaseline.length > 0) {
      series.push({
        name: "baseline-band",
        type: "custom",
        renderItem: (params, api) => {
          const categoryIndex = api.value(0) as number;
          const lowerBound = api.value(1) as number | null;
          const upperBound = api.value(2) as number | null;

          if (lowerBound == null || upperBound == null) return undefined;

          const lowCoord = api.coord([categoryIndex, lowerBound]);
          const highCoord = api.coord([categoryIndex, upperBound]);
          const sizeResult = api.size?.([1, 0]);
          const bandWidth = Array.isArray(sizeResult) ? sizeResult[0] : (sizeResult ?? 0);

          // With boundaryGap: true, data points are centered in their slots
          // Band spans from left edge to right edge of the slot (no gaps)
          const centerX = lowCoord[0];
          const x = centerX - bandWidth / 2;
          const width = bandWidth;

          return {
            type: "group",
            children: [
              // Filled rectangle
              {
                type: "rect",
                shape: { x, y: highCoord[1], width, height: lowCoord[1] - highCoord[1] },
                style: { fill: chart.palette()[2], opacity: 0.2 },
              },
              // Top dashed line
              {
                type: "line",
                shape: { x1: x, y1: highCoord[1], x2: x + width, y2: highCoord[1] },
                style: { stroke: chart.palette()[2], lineWidth: 1, lineDash: [4, 2] },
              },
              // Bottom dashed line
              {
                type: "line",
                shape: { x1: x, y1: lowCoord[1], x2: x + width, y2: lowCoord[1] },
                style: { stroke: chart.palette()[2], lineWidth: 1, lineDash: [4, 2] },
              },
            ],
          };
        },
        data: dates.map((date, i) => {
          const b = baselineMap.get(date);
          return [i, b?.lowerBound ?? null, b?.upperBound ?? null];
        }),
        silent: true,
        tooltip: { show: false },
        z: 1,
      });
    }

    // Main data line (on top)
    series.push({
      name: "HRV",
      type: "line",
      data: s.hrv.byDay.map(d => d.rmssd),
      smooth: false,
      showSymbol: false,
      itemStyle: { color: chart.palette()[1] },
      z: 10,
    });

    // Calculate axis bounds including both data and baseline range
    const dataValues = s.hrv.byDay.map(d => d.rmssd).filter((v): v is number => v != null);
    const baselineLows = rollingBaseline.map(b => b.lowerBound).filter((v): v is number => v != null);
    const baselineHighs = rollingBaseline.map(b => b.upperBound).filter((v): v is number => v != null);
    const allValues = [...dataValues, ...baselineLows, ...baselineHighs];
    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues);
    const { min: axisMin, max: axisMax } = niceAxisBounds(dataMin, dataMax);

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const items = params as { seriesName: string; axisValue: string; value: number }[];
          const main = items.find(p => p.seriesName === "HRV");
          return main ? `${main.axisValue}: ${formatHRV(main.value)}` : "";
        },
      },
      xAxis: {
        type: "category",
        data: dates,
      },
      yAxis: {
        type: "value",
        axisLabel: {
          formatter: (value: number) => `${Math.round(value)}`,
        },
        min: axisMin,
        max: axisMax,
      },
      series,
    };
  };

  // Steps chart
  const stepsChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.activity.byDay.length === 0) return null;

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const p = (params as { axisValue: string; value: number }[])[0];
          return `${p.axisValue}: ${formatSteps(p.value)} steps`;
        },
      },
      xAxis: {
        type: "category",
        data: s.activity.byDay.map(d => d.date),
      },
      yAxis: {
        type: "value",
        axisLabel: {
          formatter: (value: number) => value >= 1000 ? `${(value / 1000).toFixed(0)}k` : String(value),
        },
      },
      series: [
        {
          type: "bar",
          data: s.activity.byDay.map(d => d.steps),
          itemStyle: { color: chart.palette()[4] },
          barMaxWidth: 20,
        },
      ],
    };
  };

  // Weight chart
  const weightChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.weight.byDay.length === 0) return null;

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const items = params as { axisValue: string; value: number; seriesName: string; color: string }[];
          const lines = [`<b>${items[0].axisValue}</b>`];
          for (const item of items) {
            lines.push(`<span style="color:${item.color}">\u25CF</span> ${item.seriesName}: ${formatWeight(item.value)}`);
          }
          return lines.join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: s.weight.byDay.map(d => d.date),
      },
      yAxis: {
        type: "value",
        axisLabel: {
          formatter: (value: number) => `${value.toFixed(0)} kg`,
        },
        min: "dataMin",
        max: "dataMax",
      },
      series: [
        {
          name: "Weight",
          type: "line",
          data: s.weight.byDay.map(d => d.weight),
          smooth: false,
          showSymbol: true,
          symbol: "circle",
          symbolSize: 6,
          areaStyle: { opacity: 0.2 },
          itemStyle: { color: chart.palette()[0] },
        },
      ],
    };
  };

  // Group biomarkers by category
  const biomarkersByCategory = () => {
    const grouped = new Map<string, BiomarkerData[]>();
    for (const b of biomarkers()) {
      let group = grouped.get(b.category);
      if (!group) {
        group = [];
        grouped.set(b.category, group);
      }
      group.push(b);
    }
    return grouped;
  };

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-6xl mx-auto px-4 py-6" style={{ "--chart-card-min-width": `${chartCardMinWidth()}px` }}>
        {/* Header */}
        <div class="flex items-center justify-between mb-4">
          <h1 class="font-display text-2xl font-medium whitespace-nowrap">
            <span class="sm:hidden">Health</span>
            <span class="hidden sm:inline">Health Dashboard</span>
          </h1>
          {/* View selector */}
          <SegmentedControl options={VIEWS} value={view()} onChange={setView} />
        </div>

        {/* Period Title with Navigation */}
        <div class="flex items-center justify-center gap-3 mb-6">
          <button
            class="cursor-pointer p-2 rounded-md bg-card hover:bg-accent"
            onClick={goToPrevious}
            title="Previous"
            aria-label="Previous period"
          >
            <IconChevronLeft class="w-5 h-5" />
          </button>
          <div class="text-xl font-medium font-mono min-w-[200px] text-center">
            {periodTitle()}
          </div>
          <button
            class={`p-2 rounded-md bg-card ${
              canGoNext() ? "cursor-pointer hover:bg-accent" : "opacity-50 cursor-not-allowed"
            }`}
            onClick={goToNext}
            disabled={!canGoNext()}
            title="Next"
            aria-label="Next period"
          >
            <IconChevronRight class="w-5 h-5" />
          </button>
          <button
            class={`p-2 rounded-md bg-card ml-1 ${
              canReset() ? "cursor-pointer hover:bg-accent" : "opacity-50 cursor-not-allowed"
            }`}
            onClick={resetWindow}
            disabled={!canReset()}
            title="Reset to recent"
            aria-label="Reset to recent"
          >
            <IconSettingsBackupRestore class="w-5 h-5" />
          </button>
        </div>

        {/* Section Tabs */}
        <div class="flex items-center gap-1 mb-6 border-b border-border">
          <For each={SECTIONS}>
            {(s) => (
              <button
                class={`cursor-pointer px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  section() === s.value
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setSection(s.value)}
              >
                {s.label}
              </button>
            )}
          </For>
        </div>

        <Show when={section() !== "biomarkers"}>
          <Show when={statsQuery.isRefetchError}>
            <div class="text-center mb-4 text-sm text-red-500">
              Failed to refresh health data. Showing cached data for this period.
            </div>
          </Show>
          <Switch>
            <Match when={statsQuery.isPending}>
              <div class="text-center py-12 text-muted-foreground">Loading health data...</div>
            </Match>
            <Match when={statsQuery.isLoadingError}>
              <div class="text-center py-12 text-red-500">
                Failed to load health data for this period.
              </div>
            </Match>
            <Match when={stats()}>
              {(s) => (
                <div class="relative">
                  <Show when={statsQuery.isPlaceholderData}>
                    <div class="absolute inset-x-0 top-2 z-10 flex justify-center pointer-events-none">
                      <div
                        class="rounded-full border border-border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-xs"
                        role="status"
                      >
                        Loading health data...
                      </div>
                    </div>
                  </Show>
                  <div
                    class={`transition-opacity duration-150 ${staleContentClass(statsQuery.isPlaceholderData)}`}
                    aria-busy={statsQuery.isPlaceholderData}
                  >
              {/* Overview Section */}
              <Show when={section() === "overview"}>
                {/* Stats Cards */}
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-2xl font-bold font-mono text-indigo-400">
                      {formatSleepDuration(s().sleep.avgDuration)}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg Sleep</div>
                    <Show when={formatSleepDurationComparison(s().sleep.avgDuration, s().previousPeriod?.sleep.avgDuration, comparisonPeriodLabel())}>
                      {(comparison) => <div class="text-xs mt-1 text-muted-foreground">{comparison()}</div>}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-2xl font-bold font-mono">
                      {s().heart.avgRestingHR ? formatHeartRate(s().heart.avgRestingHR) : "-"}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg Resting HR</div>
                    <Show when={s().heart.avgRestingHR && s().previousPeriod?.heart.avgRestingHR}>
                      {(() => {
                        const comparison = formatComparison(
                          s().heart.avgRestingHR,
                          s().previousPeriod?.heart.avgRestingHR,
                          comparisonPeriodLabel(),
                          { unit: " bpm", formatter: (n) => Math.round(Math.abs(n)).toString() }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-2xl font-bold font-mono">
                      {s().hrv.avgRmssd ? formatHRV(s().hrv.avgRmssd) : "-"}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg HRV</div>
                    <Show when={s().hrv.avgRmssd && s().previousPeriod?.hrv.avgRmssd}>
                      {(() => {
                        const comparison = formatComparison(
                          s().hrv.avgRmssd,
                          s().previousPeriod?.hrv.avgRmssd,
                          comparisonPeriodLabel(),
                          { unit: " ms", formatter: (n) => Math.round(Math.abs(n)).toString() }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-2xl font-bold font-mono text-amber-400">
                      {formatSteps(Math.round(s().activity.avgSteps))}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg Daily Steps</div>
                    <Show when={s().activity.avgSteps && s().previousPeriod?.activity.avgSteps}>
                      {(() => {
                        const comparison = formatComparison(
                          s().activity.avgSteps,
                          s().previousPeriod?.activity.avgSteps,
                          comparisonPeriodLabel(),
                          { formatter: (n) => formatSteps(Math.abs(Math.round(n))) }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                </div>

                {/* Charts wrap when the selected period needs more room. */}
                <div class={`${CHART_GROUP_CLASS} mb-6`}>
                  {/* Sleep Chart */}
                  <div class="rounded-lg bg-card p-4">
                    <h3 class="text-sm font-medium text-muted-foreground mb-2">Sleep Duration</h3>
                    <Show
                      when={sleepChartOption()}
                      fallback={<div class="h-48 flex items-center justify-center text-muted-foreground">No sleep data</div>}
                    >
                      {(opt) => (
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={192} />
                      )}
                    </Show>
                  </div>

                  {/* Resting HR Chart */}
                  <div class="rounded-lg bg-card p-4">
                    <h3 class="text-sm font-medium text-muted-foreground mb-2">Resting Heart Rate</h3>
                    <Show
                      when={heartRateChartOption()}
                      fallback={<div class="h-48 flex items-center justify-center text-muted-foreground">No heart rate data</div>}
                    >
                      {(opt) => (
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={192} />
                      )}
                    </Show>
                  </div>

                  {/* HRV Chart */}
                  <div class="rounded-lg bg-card p-4">
                    <h3 class="text-sm font-medium text-muted-foreground mb-2">Heart Rate Variability (HRV)</h3>
                    <Show
                      when={hrvChartOption()}
                      fallback={<div class="h-48 flex items-center justify-center text-muted-foreground">No HRV data</div>}
                    >
                      {(opt) => (
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={192} />
                      )}
                    </Show>
                  </div>

                  {/* Steps Chart */}
                  <div class="rounded-lg bg-card p-4">
                    <h3 class="text-sm font-medium text-muted-foreground mb-2">Daily Steps</h3>
                    <Show
                      when={stepsChartOption()}
                      fallback={<div class="h-48 flex items-center justify-center text-muted-foreground">No activity data</div>}
                    >
                      {(opt) => (
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={192} />
                      )}
                    </Show>
                  </div>

                </div>

                {/* Additional Stats Row */}
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <Show when={s().spo2.avgValue > 0}>
                    <div class="rounded-lg bg-card p-4">
                      <div class="text-2xl font-bold font-mono">
                        {formatSpO2(s().spo2.avgValue)}
                      </div>
                      <div class="text-sm text-muted-foreground">Avg SpO2</div>
                    </div>
                  </Show>
                  <Show when={s().weight.latest}>
                    {(latest) => (
                      <div class="rounded-lg bg-card p-4">
                        <div class="text-2xl font-bold font-mono text-purple-400">
                          {formatWeight(latest())}
                        </div>
                        <div class="text-sm text-muted-foreground">Latest Weight</div>
                        <Show when={s().weight.change !== null}>
                          {(() => {
                            const change = s().weight.change ?? 0;
                            return (
                              <div class={`text-xs mt-1 ${change > 0 ? "text-red-400" : "text-green-400"}`}>
                                {change > 0 ? "+" : ""}{change.toFixed(1)} kg
                              </div>
                            );
                          })()}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-2xl font-bold font-mono">{formatSteps(s().activity.totalSteps)}</div>
                    <div class="text-sm text-muted-foreground">Total Steps</div>
                    <Show when={s().previousPeriod?.activity.totalSteps}>
                      {(() => {
                        const comparison = formatComparison(
                          s().activity.totalSteps,
                          s().previousPeriod?.activity.totalSteps,
                          comparisonPeriodLabel(),
                          { formatter: (n) => formatSteps(Math.abs(Math.round(n))) }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                </div>
              </Show>

              {/* Sleep Section */}
              <Show when={section() === "sleep"}>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
                  <div class="rounded-lg bg-card p-4">
                    <div class={`text-3xl font-bold font-mono ${s().sleep.avgScore ? getSleepScoreColor(s().sleep.avgScore) : "text-muted-foreground"}`}>
                      {s().sleep.avgScore ? Math.round(s().sleep.avgScore) : "-"}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg Sleep Score</div>
                    <Show when={s().sleep.avgScore && s().previousPeriod?.sleep.avgScore}>
                      {(() => {
                        const comparison = formatComparison(
                          s().sleep.avgScore,
                          s().previousPeriod?.sleep.avgScore,
                          comparisonPeriodLabel(),
                          { formatter: (n) => Math.round(Math.abs(n)).toString() }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono text-indigo-400">
                      {formatSleepDuration(s().sleep.avgDuration)}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg Duration</div>
                    <Show when={formatSleepDurationComparison(s().sleep.avgDuration, s().previousPeriod?.sleep.avgDuration, comparisonPeriodLabel())}>
                      {(comparison) => <div class="text-xs mt-1 text-muted-foreground">{comparison()}</div>}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono">
                      {formatEfficiency(s().sleep.avgEfficiency)}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg Efficiency</div>
                    <Show when={s().previousPeriod?.sleep.avgEfficiency}>
                      {(() => {
                        const comparison = formatComparison(
                          s().sleep.avgEfficiency,
                          s().previousPeriod?.sleep.avgEfficiency,
                          comparisonPeriodLabel(),
                          { unit: "%", formatter: (n) => Math.round(Math.abs(n)).toString() }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                  <Show when={s().sleep.avgBedtime != null}>
                    <div class="rounded-lg bg-card p-4">
                      <div class="text-3xl font-bold font-mono">{formatTimeOfDay(s().sleep.avgBedtime ?? 0)}</div>
                      <div class="text-sm text-muted-foreground">Avg Bedtime</div>
                    </div>
                  </Show>
                  <Show when={s().sleep.avgWakeTime != null}>
                    <div class="rounded-lg bg-card p-4">
                      <div class="text-3xl font-bold font-mono">{formatTimeOfDay(s().sleep.avgWakeTime ?? 0)}</div>
                      <div class="text-sm text-muted-foreground">Avg Wake Time</div>
                    </div>
                  </Show>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono">{s().sleep.nightsTracked}</div>
                    <div class="text-sm text-muted-foreground">Nights Tracked</div>
                  </div>
                </div>

                <div class={CHART_GROUP_CLASS}>
                  <div class="rounded-lg bg-card p-4">
                    <h3 class="text-sm font-medium text-muted-foreground mb-2">Sleep Score Over Time</h3>
                    <Show
                      when={sleepScoreChartOption()}
                      fallback={<div class="h-64 flex items-center justify-center text-muted-foreground">No sleep data</div>}
                    >
                      {(opt) => (
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={256} />
                      )}
                    </Show>
                  </div>

                  <div class="rounded-lg bg-card p-4">
                    <h3 class="text-sm font-medium text-muted-foreground mb-2">Sleep Duration Over Time</h3>
                    <Show
                      when={sleepChartOption()}
                      fallback={<div class="h-64 flex items-center justify-center text-muted-foreground">No sleep data</div>}
                    >
                      {(opt) => (
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={256} />
                      )}
                    </Show>
                  </div>

                  <Show when={sleepScheduleChartOption()}>
                    {(opt) => (
                      <div class="rounded-lg bg-card p-4">
                        <h3 class="text-sm font-medium text-muted-foreground mb-2">Sleep Schedule</h3>
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={256} />
                      </div>
                    )}
                  </Show>
                </div>
              </Show>

              {/* Heart Section */}
              <Show when={section() === "heart"}>
                <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono">
                      {s().heart.avgRestingHR ? formatHeartRate(s().heart.avgRestingHR) : "-"}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg Resting HR</div>
                    <Show when={s().heart.avgRestingHR && s().previousPeriod?.heart.avgRestingHR}>
                      {(() => {
                        const comparison = formatComparison(
                          s().heart.avgRestingHR,
                          s().previousPeriod?.heart.avgRestingHR,
                          comparisonPeriodLabel(),
                          { unit: " bpm", formatter: (n) => Math.round(Math.abs(n)).toString() }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono">
                      {s().hrv.avgRmssd ? formatHRV(s().hrv.avgRmssd) : "-"}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg HRV (RMSSD)</div>
                    <Show when={s().hrv.avgRmssd && s().previousPeriod?.hrv.avgRmssd}>
                      {(() => {
                        const comparison = formatComparison(
                          s().hrv.avgRmssd,
                          s().previousPeriod?.hrv.avgRmssd,
                          comparisonPeriodLabel(),
                          { unit: " ms", formatter: (n) => Math.round(Math.abs(n)).toString() }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                  <Show when={s().spo2.avgValue > 0}>
                    <div class="rounded-lg bg-card p-4">
                      <div class="text-3xl font-bold font-mono">
                        {formatSpO2(s().spo2.avgValue)}
                      </div>
                      <div class="text-sm text-muted-foreground">Avg SpO2</div>
                      <Show when={s().previousPeriod?.spo2.avgValue}>
                        {(() => {
                          const comparison = formatComparison(
                            s().spo2.avgValue,
                            s().previousPeriod?.spo2.avgValue,
                            comparisonPeriodLabel(),
                            { unit: "%", formatter: (n) => Math.abs(n).toFixed(1) }
                          );
                          return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                        })()}
                      </Show>
                    </div>
                  </Show>
                </div>

                <div class={CHART_GROUP_CLASS}>
                  <div class="rounded-lg bg-card p-4">
                    <h3 class="text-sm font-medium text-muted-foreground mb-2">Resting Heart Rate</h3>
                    <Show
                      when={heartRateChartOption()}
                      fallback={<div class="h-64 flex items-center justify-center text-muted-foreground">No heart rate data</div>}
                    >
                      {(opt) => (
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={256} />
                      )}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <h3 class="text-sm font-medium text-muted-foreground mb-2">Heart Rate Variability (HRV)</h3>
                    <Show
                      when={hrvChartOption()}
                      fallback={<div class="h-64 flex items-center justify-center text-muted-foreground">No HRV data</div>}
                    >
                      {(opt) => (
                        <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={256} />
                      )}
                    </Show>
                  </div>
                </div>
              </Show>

              {/* Activity Section */}
              <Show when={section() === "activity"}>
                <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono text-amber-400">
                      {formatSteps(Math.round(s().activity.avgSteps))}
                    </div>
                    <div class="text-sm text-muted-foreground">Avg Daily Steps</div>
                    <Show when={s().activity.avgSteps && s().previousPeriod?.activity.avgSteps}>
                      {(() => {
                        const comparison = formatComparison(
                          s().activity.avgSteps,
                          s().previousPeriod?.activity.avgSteps,
                          comparisonPeriodLabel(),
                          { formatter: (n) => formatSteps(Math.abs(Math.round(n))) }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono">
                      {formatSteps(s().activity.totalSteps)}
                    </div>
                    <div class="text-sm text-muted-foreground">Total Steps</div>
                    <Show when={s().previousPeriod?.activity.totalSteps}>
                      {(() => {
                        const comparison = formatComparison(
                          s().activity.totalSteps,
                          s().previousPeriod?.activity.totalSteps,
                          comparisonPeriodLabel(),
                          { formatter: (n) => formatSteps(Math.abs(Math.round(n))) }
                        );
                        return comparison ? <div class="text-xs mt-1 text-muted-foreground">{comparison}</div> : null;
                      })()}
                    </Show>
                  </div>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono">{s().activity.daysTracked}</div>
                    <div class="text-sm text-muted-foreground">Days Tracked</div>
                  </div>
                </div>

                <div class="rounded-lg bg-card p-4">
                  <h3 class="text-sm font-medium text-muted-foreground mb-2">Daily Steps</h3>
                  <Show
                    when={stepsChartOption()}
                    fallback={<div class="h-64 flex items-center justify-center text-muted-foreground">No activity data</div>}
                  >
                    {(opt) => (
                      <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={256} />
                    )}
                  </Show>
                </div>
              </Show>

              {/* Weight Section */}
              <Show when={section() === "weight"}>
                <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                  <Show when={s().weight.latest}>
                    {(latest) => (
                      <div class="rounded-lg bg-card p-4">
                        <div class="text-3xl font-bold font-mono text-purple-400">
                          {formatWeight(latest())}
                        </div>
                        <div class="text-sm text-muted-foreground">Latest Weight</div>
                      </div>
                    )}
                  </Show>
                  <Show when={s().weight.change !== null}>
                    {(() => {
                      const change = s().weight.change ?? 0;
                      return (
                        <div class="rounded-lg bg-card p-4">
                          <div class={`text-3xl font-bold font-mono ${change > 0 ? "text-red-400" : "text-green-400"}`}>
                            {change > 0 ? "+" : ""}{change.toFixed(1)} kg
                          </div>
                          <div class="text-sm text-muted-foreground">Change</div>
                        </div>
                      );
                    })()}
                  </Show>
                  <div class="rounded-lg bg-card p-4">
                    <div class="text-3xl font-bold font-mono">{s().weight.measurements}</div>
                    <div class="text-sm text-muted-foreground">Measurements</div>
                  </div>
                </div>

                <div class="rounded-lg bg-card p-4">
                  <h3 class="text-sm font-medium text-muted-foreground mb-2">Weight Trend</h3>
                  <Show
                    when={weightChartOption()}
                    fallback={<div class="h-64 flex items-center justify-center text-muted-foreground">No weight data</div>}
                  >
                    {(opt) => (
                      <DateChart option={chart.option(opt())} view={displayedPeriod().view} height={256} />
                    )}
                  </Show>
                </div>
              </Show>

                  </div>
                </div>
              )}
            </Match>
          </Switch>
        </Show>

        <Show when={section() === "biomarkers"}>
          <Show when={biomarkersQuery.isRefetchError}>
            <div class="text-center mb-4 text-sm text-red-500">
              Failed to refresh biomarkers. Showing cached data.
            </div>
          </Show>
          <Switch>
            <Match when={biomarkersQuery.isPending}>
              <div class="text-center py-12 text-muted-foreground">Loading biomarkers...</div>
            </Match>
            <Match when={biomarkersQuery.isLoadingError}>
              <div class="text-center py-12 text-red-500">Failed to load biomarkers.</div>
            </Match>
            <Match when={biomarkers().length === 0}>
              <div class="text-center py-12 text-muted-foreground">
                No biomarker data available. Import Thriva blood test results to see them here.
              </div>
            </Match>
            <Match when={biomarkers().length > 0}>
              <For each={Array.from(biomarkersByCategory().entries())}>
                {([category, items]) => (
                  <div class="mb-6">
                    <h3 class="flex items-center gap-2 mb-3">
                      <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {category}
                      </span>
                      <span class="h-px flex-1 bg-border" />
                    </h3>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <For each={items}>
                        {(biomarker) => {
                          const latest = biomarker.results[biomarker.results.length - 1];
                          return (
                            <button
                              class="rounded-lg bg-card p-4 text-left cursor-pointer hover:bg-accent/30 transition-colors w-full"
                              onClick={() => setSelectedBiomarker(biomarker)}
                            >
                              <div class="flex items-baseline justify-between mb-1">
                                <span class="font-medium text-sm">{biomarker.name}</span>
                                <span class="text-lg font-semibold font-mono">
                                  {latest.value} <span class="text-muted-foreground text-sm font-normal">{latest.unit}</span>
                                </span>
                              </div>
                              <Show when={latest.referenceRanges && latest.referenceRanges.length > 0}>
                                <BiomarkerRangeIndicator
                                  value={latest.value}
                                  unit={latest.unit}
                                  level={latest.level}
                                  referenceRanges={latest.referenceRanges}
                                />
                              </Show>
                              <div class="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                                <span class="font-mono">{formatDate(latest.date)}</span>
                                <Show when={biomarker.results.length > 1}>
                                  <span>
                                    <span class="font-mono">{biomarker.results.length}</span> results
                                  </span>
                                </Show>
                              </div>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </Match>
          </Switch>
        </Show>
      </div>

      {/* Biomarker detail modal */}
      <BiomarkerDetailModal
        biomarker={selectedBiomarker()}
        open={selectedBiomarker() !== null}
        onClose={() => setSelectedBiomarker(null)}
      />
    </div>
  );
}
