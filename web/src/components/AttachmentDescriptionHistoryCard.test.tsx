import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentDescriptionHistoryPoint } from "../lib/api";
import AttachmentDescriptionHistoryCard from "./AttachmentDescriptionHistoryCard";

interface QueryState {
  isPending: boolean;
  isLoadingError: boolean;
  isRefetchError: boolean;
  data?: { points: AttachmentDescriptionHistoryPoint[] };
}

const testState = vi.hoisted(() => ({
  setQueryState: (_state: unknown) => {},
  refetch: vi.fn(),
  getOption: (() => undefined) as () => unknown,
}));

vi.mock("../lib/queries", async () => {
  const { createSignal } = await import("solid-js");
  const [state, setState] = createSignal<QueryState>({
    isPending: true,
    isLoadingError: false,
    isRefetchError: false,
  });
  testState.setQueryState = (next) => setState(next as QueryState);

  const query = {
    get isPending() {
      return state().isPending;
    },
    get isLoadingError() {
      return state().isLoadingError;
    },
    get isRefetchError() {
      return state().isRefetchError;
    },
    get data() {
      return state().data;
    },
    refetch: testState.refetch,
  };

  return { useAttachmentDescriptionHistory: () => query };
});

vi.mock("../lib/echarts-theme", () => ({
  useChartTheme: () => ({
    option: (option: unknown) => option,
    palette: () => ["#625690", "#4c7c8c", "#8c7c4c", "#3d3560", "#2b2740", "#b4544c"],
  }),
}));

vi.mock("../ui/echarts", () => ({
  // Keep the live option accessor so tests can exercise the tooltip formatter,
  // which JSON serialisation would drop.
  EChartsAutoSize: (props: { option: unknown }) => {
    testState.getOption = () => props.option;
    return <div data-testid="history-chart" />;
  },
}));

const DAY_MS = 86_400_000;
/** Synthetic, timezone-stable clock so the rolling windows are deterministic. */
const NOW = new Date("2026-08-28T09:30:00Z");
/** 44 consecutive days ending on 2026-08-28 start here. */
const START_MS = Date.UTC(2026, 6, 16);

function isoDay(index: number): string {
  return new Date(START_MS + index * DAY_MS).toISOString().slice(0, 10);
}

function makePoints(
  count: number,
  overrides: (index: number) => Partial<AttachmentDescriptionHistoryPoint> = () => ({}),
): AttachmentDescriptionHistoryPoint[] {
  return Array.from({ length: count }, (_unused, index) => {
    const depth = 5000 - index * 100;
    return {
      date: isoDay(index),
      queueDepth: depth,
      descriptionEligibleHashes: null,
      describedHashes: null,
      described: 100 + index,
      skipped: 2,
      failed: index % 10 === 0 ? 1 : 0,
      runs: 12,
      failedRuns: 1,
      deferredRuns: 0,
      ...overrides(index),
    } satisfies AttachmentDescriptionHistoryPoint;
  });
}

interface ChartSeries {
  name: string;
  type?: string;
  stack?: string;
  itemStyle?: { color?: string };
  data: [number, number | null][];
}

interface ChartOption {
  animation: boolean;
  legend: { show: boolean };
  tooltip: { formatter: (params: unknown) => string };
  xAxis: { min: number; max: number; minInterval: number; splitNumber: number; axisLabel: { hideOverlap: boolean } };
  yAxis: { name?: string }[];
  series: ChartSeries[];
}

/** The option is the responsive `baseOption` + `media` form. */
interface ResponsiveChartOption {
  baseOption: ChartOption;
  media: { query: { maxWidth: number }; option: { xAxis: { splitNumber: number } } }[];
}

function responsiveOption(): ResponsiveChartOption {
  return testState.getOption() as ResponsiveChartOption;
}

function chartOption(): ChartOption {
  return responsiveOption().baseOption;
}

function chartSeries(name: string): ChartSeries {
  const found = chartOption().series.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing series: ${name}`);
  return found;
}

function loaded(points: AttachmentDescriptionHistoryPoint[]) {
  testState.setQueryState({
    isPending: false,
    isLoadingError: false,
    isRefetchError: false,
    data: { points },
  });
}

function renderCard() {
  return render(() => <AttachmentDescriptionHistoryCard />);
}

describe("AttachmentDescriptionHistoryCard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    testState.refetch.mockClear();
    testState.setQueryState({ isPending: true, isLoadingError: false, isRefetchError: false });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the whole recorded trend in the default 90-day view", () => {
    loaded(makePoints(44));

    const view = renderCard();

    expect(view.getByRole("radio", { name: "90d" })).toBeChecked();
    // The header states the span once: no range label, no recorded-day count.
    expect(view.getByText("Jul 16 – Aug 28, 2026")).toBeInTheDocument();
    expect(view.queryByText(/Last 90 days/)).not.toBeInTheDocument();
    expect(view.queryByText(/recorded day/)).not.toBeInTheDocument();

    expect(chartSeries("Backlog").data).toHaveLength(44);
    expect(chartSeries("Backlog").data[0]).toEqual([START_MS, 5000]);

    // Two headline numbers; run-level detail is not one of them.
    expect(view.getByText("Latest backlog")).toBeInTheDocument();
    expect(view.getByText("Descriptions added")).toBeInTheDocument();
    expect(view.getByText(/Aug 28 · 4,300 fewer than Jul 16/)).toBeInTheDocument();
    expect(view.queryByText("Runs")).not.toBeInTheDocument();
  });

  it("keeps skipped and failed detail quiet and conditional", () => {
    loaded(makePoints(44));

    const view = renderCard();

    // Failures exist in this fixture.
    expect(view.getByText("88 skipped")).toBeInTheDocument();
    expect(view.getByText("5 failed")).toBeInTheDocument();

    cleanup();
    loaded(makePoints(44, () => ({ skipped: 0, failed: 0, deferredRuns: 0 })));
    const clean = renderCard();

    expect(clean.queryByText(/skipped/)).not.toBeInTheDocument();
    expect(clean.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it("narrows to the last 30 recorded days without refetching", () => {
    loaded(makePoints(44));

    const view = renderCard();
    expect(chartSeries("Backlog").data).toHaveLength(44);

    fireEvent.click(view.getByRole("radio", { name: "30d" }));

    expect(view.getByRole("radio", { name: "30d" })).toBeChecked();
    expect(view.getByText("Jul 30 – Aug 28, 2026")).toBeInTheDocument();
    expect(chartSeries("Backlog").data).toHaveLength(30);
    expect(chartSeries("Backlog").data[0]).toEqual([START_MS + 14 * DAY_MS, 3600]);
    expect(testState.refetch).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("radio", { name: "All" }));
    expect(chartSeries("Backlog").data).toHaveLength(44);
    expect(testState.refetch).not.toHaveBeenCalled();
  });

  it("plots the backlog line over one stacked bar of daily outcomes", () => {
    loaded(makePoints(44));

    const view = renderCard();

    expect(chartOption().animation).toBe(false);
    // The canvas legend stays off; the HTML strip above the chart is the legend.
    expect(chartOption().legend).toEqual({ show: false });
    for (const label of ["Backlog", "Described", "Skipped", "Failed"]) {
      expect(view.getAllByText(label).length).toBeGreaterThan(0);
    }
    // The removed intra-day band is gone from the legend and the series.
    expect(view.queryByText(/low–high/)).not.toBeInTheDocument();
    expect(chartOption().series.map((entry) => entry.name)).toEqual([
      "Described",
      "Skipped",
      "Failed",
      "Backlog",
    ]);

    // Three outcome series share one stack, and described/failed are clearly
    // different hues rather than two neighbouring palette purples.
    const outcomes = ["Described", "Skipped", "Failed"].map(chartSeries);
    expect(outcomes.every((entry) => entry.type === "bar" && entry.stack === "outcomes"))
      .toBe(true);
    expect(chartSeries("Described").itemStyle?.color).toBe("#34a08f");
    expect(chartSeries("Failed").itemStyle?.color).toBe("#e0524b");
    expect(chartSeries("Described").data[0]).toEqual([START_MS, 100]);

    expect(chartOption().yAxis).toHaveLength(2);
    // Axis names live in the legend strip, so nothing collides on mobile.
    expect(chartOption().yAxis.every((axis) => axis.name === undefined)).toBe(true);

    const tooltip = chartOption().tooltip.formatter([{ axisValue: START_MS }]);
    expect(tooltip).toContain("Backlog: 5,000 files");
    expect(tooltip).toContain("100 described · 2 skipped · 1 failed");
    expect(tooltip).toContain("12 runs · 1 failed");
    expect(tooltip).not.toContain("low–high");

    // Meaning is available without colour, via a text summary of the chart.
    const summary = view.getByRole("img").getAttribute("aria-label") ?? "";
    expect(summary).toContain("Attachment description backlog by day");
    expect(summary).toContain("Backlog 700 files");
    expect(summary).toContain("4,300 fewer");
    expect(summary).toContain("Description outcomes in range");
    expect(summary).not.toContain("low to high");
  });

  it("dates the latest backlog when newer history has no queue reading", () => {
    loaded(makePoints(44, (index) => (index >= 40 ? { queueDepth: null } : {})));

    const view = renderCard();

    expect(view.getByText("Latest backlog")).toBeInTheDocument();
    expect(view.getByText(/Aug 24 · 3,900 fewer than Jul 16/)).toBeInTheDocument();
  });

  it("keeps the time axis sparse and collision-free at phone widths", () => {
    loaded(makePoints(44));
    renderCard();

    const option = responsiveOption();
    // ECharts makes room for the edge bars, so no additional date padding is needed.
    expect(option.baseOption.xAxis.min).toBe(START_MS);
    expect(option.baseOption.xAxis.max).toBe(START_MS + 43 * DAY_MS);
    // Base contract: never tick finer than a day, drop overlapping labels.
    expect(option.baseOption.xAxis.minInterval).toBe(DAY_MS);
    expect(option.baseOption.xAxis.splitNumber).toBe(5);
    expect(option.baseOption.xAxis.axisLabel.hideOverlap).toBe(true);
    // Narrow containers (phone-width cards) ask for roughly 3–5 date ticks.
    expect(option.media).toEqual([
      { query: { maxWidth: 480 }, option: { xAxis: { splitNumber: 3 } } },
    ]);
  });

  it("omits coverage entirely until two recorded snapshots exist in the range", () => {
    loaded(
      makePoints(44, (index) =>
        index === 43 ? { descriptionEligibleHashes: 1000, describedHashes: 780 } : {}
      ),
    );

    const view = renderCard();

    // No placeholder prose, no half-truthful figure: the row simply is absent.
    expect(view.queryByText("Eligible described")).not.toBeInTheDocument();
    expect(view.queryByText(/78%/)).not.toBeInTheDocument();
    expect(view.queryByText(/snapshot/i)).not.toBeInTheDocument();
    expect(view.getByTestId("history-chart")).toBeInTheDocument();
  });

  it("reduces coverage to one percentage and its point change", () => {
    loaded(
      makePoints(44, (index) => {
        if (index === 42) return { descriptionEligibleHashes: 1000, describedHashes: 620 };
        if (index === 43) return { descriptionEligibleHashes: 1000, describedHashes: 780 };
        return {};
      }),
    );

    const view = renderCard();

    expect(view.getByText("Eligible described")).toBeInTheDocument();
    expect(view.getByText("78%")).toBeInTheDocument();
    expect(view.getByText("+16 pts since Aug 27")).toBeInTheDocument();
    // No second percentage, no percent-to-percent arrow, no raw counts.
    expect(view.queryByText(/62%/)).not.toBeInTheDocument();
    expect(view.queryByText(/→/)).not.toBeInTheDocument();
    expect(view.queryByText(/1,000/)).not.toBeInTheDocument();
    expect(view.queryByText(/eligible/)).not.toBeInTheDocument();

    const summary = view.getByRole("img").getAttribute("aria-label") ?? "";
    expect(summary).toContain("Coverage 78 percent, up 16 points since Aug 27.");
  });

  it("reports an empty rolling window instead of passing off stale days as recent", () => {
    // Every point is older than 30 days relative to the fake clock.
    loaded(makePoints(44).slice(0, 5));

    const view = renderCard();
    fireEvent.click(view.getByRole("radio", { name: "30d" }));

    expect(view.getByText(/No description runs recorded in the last 30 days/))
      .toBeInTheDocument();
    expect(view.queryByTestId("history-chart")).not.toBeInTheDocument();

    fireEvent.click(view.getByRole("radio", { name: "All" }));

    expect(view.getByTestId("history-chart")).toBeInTheDocument();
    expect(chartSeries("Backlog").data).toHaveLength(5);
  });

  it("keeps loading and error states inline and recoverable", () => {
    const view = renderCard();
    expect(view.getByLabelText("Loading description history")).toBeInTheDocument();
    expect(view.queryByTestId("history-chart")).not.toBeInTheDocument();

    testState.setQueryState({
      isPending: false,
      isLoadingError: true,
      isRefetchError: false,
    });
    expect(view.getByText("Could not load description history.")).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(testState.refetch).toHaveBeenCalledTimes(1);

    // The range control stays usable throughout.
    expect(view.getByRole("radiogroup", { name: "History range" })).toBeInTheDocument();
  });

  it("keeps cached history visible when a refresh fails", () => {
    const points = makePoints(44);
    loaded(points);
    const view = renderCard();

    testState.setQueryState({
      isPending: false,
      isLoadingError: false,
      isRefetchError: true,
      data: { points },
    });

    expect(view.getByTestId("history-chart")).toBeInTheDocument();
    expect(view.getByText("Could not refresh; showing saved history.")).toBeInTheDocument();
    expect(view.queryByText("Could not load description history.")).not.toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(testState.refetch).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when no description history has been recorded", () => {
    loaded([]);

    const view = renderCard();

    expect(view.queryByRole("radiogroup", { name: "History range" })).not.toBeInTheDocument();
    expect(view.container.querySelector("section")).toBeNull();
    expect(view.queryByTestId("history-chart")).not.toBeInTheDocument();
  });
});
