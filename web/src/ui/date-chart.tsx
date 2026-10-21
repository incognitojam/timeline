import { parseHealthDateOnly } from "@shared/health-periods";
import type { EChartsOption } from "echarts";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { EChartsAutoSize } from "./echarts";

type DateChartView = "week" | "month" | "year";

const GRID_LEFT = 0.03;
const GRID_RIGHT = 0.04;
const Y_AXIS_LABEL_SPACE = 48;
const dateLabelWidth = (view: DateChartView) => view === "month" ? 18 : 32;

export function dateChartMinWidth(count: number, view: DateChartView): number {
  return Math.ceil((Y_AXIS_LABEL_SPACE + count * dateLabelWidth(view)) / (1 - GRID_LEFT - GRID_RIGHT));
}

export function dateChartLabels(dates: string[], view: DateChartView, locale?: Intl.LocalesArgument): string[] {
  return dates.map((value, index) => {
    const date = parseHealthDateOnly(value.slice(0, 10));
    const month = date.toLocaleDateString(locale, { month: "short" });
    const previous = dates[index - 1];
    const yearChanged = previous !== undefined && previous.slice(0, 4) !== value.slice(0, 4);
    if (view === "year") return yearChanged ? `${month}\n${date.getFullYear()}` : month;

    const monthChanged = previous === undefined || previous.slice(0, 7) !== value.slice(0, 7);
    const day = String(date.getDate());
    const label = view === "week"
      ? `${date.toLocaleDateString(locale, { weekday: "short" })}\n${day}`
      : day;
    return monthChanged ? `${label}\n${month}${yearChanged ? `\n${date.getFullYear()}` : ""}` : label;
  });
}

/** Shared spacing and calendar labels for charts with daily or monthly buckets. */
export function DateChart(props: { option: EChartsOption; view: DateChartView; height?: number }) {
  let container: HTMLDivElement | undefined;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    const element = container;
    if (!element) throw new Error("Date chart was not mounted");
    const measure = () => {
      if (element.clientWidth > 0) setWidth(element.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    onCleanup(() => observer.disconnect());
  });
  const layout = createMemo(() => {
    const axis = props.option.xAxis;
    if (!axis || Array.isArray(axis) || axis.type !== "category" || !axis.data) {
      throw new Error("DateChart requires one category x-axis with date strings");
    }
    const dates = axis.data.map(value => {
      if (typeof value !== "string") throw new Error("DateChart categories must be date strings");
      return value;
    });
    const rawLabels = dateChartLabels(dates, props.view);
    const lineHeight = 16;
    // Budget for the widest y-axis labels; ECharts fits each axis to its actual text.
    const slotWidth = Math.max(1, width() * (1 - GRID_LEFT - GRID_RIGHT) - Y_AXIS_LABEL_SPACE) / Math.max(1, dates.length);
    const primaryRows = props.view === "week" ? 2 : 1;
    const stride = Math.max(1, Math.ceil(dateLabelWidth(props.view) / slotWidth));
    const ticks = new Set<number>();
    for (let index = 0; index < dates.length; index += stride) ticks.add(index);
    const last = dates.length - 1;
    if (last > 0) {
      // Keep the range endpoints without crowding the penultimate tick.
      for (const index of ticks) if (index !== 0 && last - index < stride) ticks.delete(index);
      ticks.add(last);
    }
    const annotationEnds: number[] = [];
    const labels = rawLabels.map((label, index) => {
      const lines = label.split("\n");
      let result = ticks.has(index) ? lines.slice(0, primaryRows).join("\n") : "\n".repeat(primaryRows - 1);
      const annotation = lines.slice(primaryRows);
      if (annotation.length) {
        // Nearby month changes get separate rows, including a range starting on the 31st.
        let row = 0;
        while (annotationEnds[row] !== undefined && (index - annotationEnds[row]) * slotWidth < 40) row++;
        for (let i = 0; i < annotation.length; i++) annotationEnds[row + i] = index;
        result += "\n".repeat(1 + row) + annotation.join("\n");
      }
      return result;
    });
    const rows = Math.max(2, ...labels.map(label => label.split("\n").length));
    const grid = props.option.grid;
    if (Array.isArray(grid)) throw new Error("DateChart requires one grid");
    return {
      height: Math.max(props.height ?? 256, rows * lineHeight + 160),
      option: {
        ...props.option,
        animationDurationUpdate: 0,
        grid: { top: 8, ...grid, left: `${GRID_LEFT * 100}%`, right: `${GRID_RIGHT * 100}%`, bottom: 0, containLabel: true },
        xAxis: {
          ...axis,
          boundaryGap: true,
          axisTick: { alignWithLabel: true, interval: (index: number) => ticks.has(index) },
          axisLabel: {
            ...axis.axisLabel,
            fontSize: 12,
            lineHeight,
            interval: 0,
            hideOverlap: false,
            formatter: (_value: string, index: number) => labels[index],
          },
        },
      } satisfies EChartsOption,
    };
  });
  return (
    <div
      ref={container}
      style={{ width: "100%", height: `${layout().height}px` }}
      role="region"
      aria-label="Date chart"
    >
      <Show when={width() > 0}>
        <EChartsAutoSize option={layout().option} waitForFont />
      </Show>
    </div>
  );
}
