import { Show, For, createMemo } from "solid-js";
import { EChartsAutoSize } from "../ui/echarts";
import Dialog from "../ui/Dialog";
import type { EChartsOption } from "echarts";
import type { BiomarkerData, BiomarkerReferenceRange } from "../lib/api";
import { useChartTheme } from "../lib/echarts-theme";
import {
  getBiomarkerLevelColor,
  normalizeRangePosition,
  referenceRangeExtent,
  sortReferenceRanges,
  type BiomarkerLevel,
} from "../lib/health-utils";

interface Props {
  biomarker: BiomarkerData | null;
  open: boolean;
  onClose: () => void;
}

// Get level color for range zones (same as HealthDashboard)
function getZoneColor(level: string) {
  switch (level) {
    case "optimal": return "rgba(34, 197, 94, 0.2)"; // green-500
    case "normal": return "rgba(59, 130, 246, 0.2)"; // blue-500
    case "abnormal": return "rgba(234, 179, 8, 0.2)"; // yellow-500
    case "highly_abnormal": return "rgba(239, 68, 68, 0.2)"; // red-500
    default: return "rgba(107, 114, 128, 0.2)"; // gray-500
  }
}

// Get marker color based on level
function getMarkerColor(level: string) {
  switch (level) {
    case "optimal": return "#22c55e";
    case "normal": return "#3b82f6";
    case "abnormal": return "#eab308";
    case "highly_abnormal": return "#ef4444";
    default: return "#6b7280";
  }
}

// Zone background color classes for range indicator
function getZoneColorClass(level: string) {
  switch (level) {
    case "optimal": return "bg-green-500/20";
    case "normal": return "bg-blue-500/20";
    case "abnormal": return "bg-yellow-500/20";
    case "highly_abnormal": return "bg-red-500/20";
    default: return "bg-gray-500/20";
  }
}

// Marker color classes
function getMarkerColorClass(level: string) {
  switch (level) {
    case "optimal": return "bg-green-500";
    case "normal": return "bg-blue-500";
    case "abnormal": return "bg-yellow-500";
    case "highly_abnormal": return "bg-red-500";
    default: return "bg-gray-500";
  }
}

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

// Format short date for chart
function formatChartDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
  });
}

// Format level text
function formatLevel(level: string): string {
  switch (level) {
    case "optimal": return "Optimal";
    case "normal": return "Normal";
    case "abnormal": return "Abnormal";
    case "highly_abnormal": return "Highly Abnormal";
    default: return level;
  }
}

// Inline range indicator (same logic as HealthDashboard)
function RangeIndicator(props: {
  value: number;
  level: string;
  referenceRanges: BiomarkerReferenceRange[];
}) {
  const sortedRanges = () => sortReferenceRanges(props.referenceRanges);

  const rangeExtent = () => referenceRangeExtent(sortedRanges());

  const markerPosition = () => {
    const { min, max } = rangeExtent();
    return normalizeRangePosition(props.value, min, max) * 100;
  };

  return (
    <div class="mt-2">
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
                class={`h-full ${getZoneColorClass(range.level)}`}
                style={{ width: `${width}%` }}
                title={`${range.name}: ${range.lower_bound ?? '<'} - ${range.upper_bound ?? '>'}`}
              />
            );
          }}
        </For>
        <div
          class={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full ${getMarkerColorClass(props.level)} border-2 border-background shadow-sm`}
          style={{ left: `calc(${markerPosition()}% - 6px)` }}
        />
      </div>
    </div>
  );
}

export default function BiomarkerDetailModal(props: Props) {
  const chart = useChartTheme();
  const latest = () => {
    if (!props.biomarker) return null;
    return props.biomarker.results[props.biomarker.results.length - 1];
  };

  // Calculate range extent from all reference ranges across all results
  const rangeExtent = createMemo(() => {
    if (!props.biomarker) return { min: 0, max: 100 };

    let min = Infinity;
    let max = -Infinity;

    // Also include actual values
    for (const result of props.biomarker.results) {
      if (result.value < min) min = result.value;
      if (result.value > max) max = result.value;

      for (const r of result.referenceRanges) {
        if (r.lower_bound !== null && r.lower_bound < min) min = r.lower_bound;
        if (r.upper_bound !== null && r.upper_bound > max) max = r.upper_bound;
      }
    }

    const range = max - min;
    if (min === Infinity) min = 0;
    if (max === -Infinity) max = 100;
    if (range > 0) {
      min = Math.max(0, min - range * 0.1);
      max = max + range * 0.1;
    }

    return { min, max };
  });

  // Build chart option
  const chartOption = createMemo((): EChartsOption | null => {
    if (!props.biomarker || props.biomarker.results.length < 2) return null;

    const results = props.biomarker.results;
    const dates = results.map(r => formatChartDate(r.date));
    const values = results.map(r => r.value);
    const { min, max } = rangeExtent();

    // Get reference ranges from latest result (assume consistent across results)
    const latestResult = results[results.length - 1];
    const referenceRanges = latestResult.referenceRanges || [];

    // Sort ranges by lower_bound
    const sortedRanges = [...referenceRanges]
      .filter(r => r.lower_bound !== null || r.upper_bound !== null)
      .sort((a, b) => {
        const aVal = a.lower_bound ?? -Infinity;
        const bVal = b.lower_bound ?? -Infinity;
        return aVal - bVal;
      });

    // Create mark areas for reference range zones
    const markAreaData = sortedRanges.map(range => {
      const lower = range.lower_bound ?? min;
      const upper = range.upper_bound ?? max;
      return [{
        yAxis: lower,
        itemStyle: { color: getZoneColor(range.level) },
      }, {
        yAxis: upper,
      }] as const;
    });

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const items = params as { axisValue: string; value: number; dataIndex: number }[];
          const item = items[0];
          if (!item) return "";
          const result = results[item.dataIndex];
          return `${formatDate(result.date)}<br/><strong>${item.value} ${result.unit}</strong><br/>${formatLevel(result.level)}`;
        },
      },
      grid: { left: "3%", right: "4%", top: "8%", bottom: "3%", containLabel: true },
      xAxis: {
        type: "category",
        data: dates,
        axisLabel: {
          interval: 0,
          rotate: dates.length > 6 ? 45 : 0,
        },
      },
      yAxis: {
        type: "value",
        min: Math.floor(min),
        max: Math.ceil(max),
        axisLabel: {
          formatter: (value: number) => `${value}`,
        },
      },
      series: [{
        name: props.biomarker.name,
        type: "line",
        data: values,
        smooth: true,
        showSymbol: true,
        symbolSize: 8,
        itemStyle: {
          color: getMarkerColor(latestResult.level),
        },
        lineStyle: {
          width: 2,
        },
        markArea: {
          silent: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: markAreaData as any,
        },
      }],
    };
  });

  return (
    <Show when={props.biomarker}>
      {(biomarker) => (
        <Dialog
          open={props.open}
          onClose={props.onClose}
          title={biomarker().name}
          description={<span class="uppercase tracking-wide">{biomarker().category}</span>}
          class="max-w-2xl"
        >
          {/* Latest value with range indicator */}
          <Show when={latest()}>
            {(l) => (
              <div class="mb-6 p-4 rounded-lg bg-card">
                <div class="flex items-baseline justify-between mb-1">
                  <span class="text-sm text-muted-foreground">Current</span>
                  <span class="text-2xl font-semibold">
                    {l().value} <span class="text-muted-foreground text-base font-normal">{l().unit}</span>
                  </span>
                </div>
                <Show when={l().referenceRanges && l().referenceRanges.length > 0}>
                  <RangeIndicator
                    value={l().value}
                    level={l().level}
                    referenceRanges={l().referenceRanges}
                  />
                </Show>
                <div class="mt-2 text-xs text-muted-foreground">
                  <span class={getBiomarkerLevelColor(l().level as BiomarkerLevel)}>
                    {formatLevel(l().level)}
                  </span>
                  {" · "}
                  {formatDate(l().date)}
                </div>
              </div>
            )}
          </Show>

          {/* Historical chart */}
          <Show when={chartOption()}>
            {(opt) => (
              <div class="mb-6">
                <h4 class="text-sm font-medium mb-3">History</h4>
                <div class="h-64 border border-border rounded-lg p-2 bg-card">
                  <EChartsAutoSize option={chart.option(opt())} />
                </div>
              </div>
            )}
          </Show>

          {/* Historical results table */}
          <div>
            <h4 class="text-sm font-medium mb-3">All Results</h4>
            <div class="border border-border rounded-lg overflow-hidden">
              <table class="w-full text-sm">
                <thead class="bg-muted/50">
                  <tr>
                    <th class="text-left px-4 py-2 font-medium">Date</th>
                    <th class="text-right px-4 py-2 font-medium">Value</th>
                    <th class="text-right px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={[...biomarker().results].reverse()}>
                    {(result) => (
                      <tr class="border-t border-border">
                        <td class="px-4 py-2">{formatDate(result.date)}</td>
                        <td class="text-right px-4 py-2">
                          {result.value} {result.unit}
                        </td>
                        <td class={`text-right px-4 py-2 ${getBiomarkerLevelColor(result.level as BiomarkerLevel)}`}>
                          {formatLevel(result.level)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        </Dialog>
      )}
    </Show>
  );
}
