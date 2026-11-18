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

interface ChartOption {
  baseOption: {
    tooltip: { formatter: (params: unknown) => string };
    series: { name: string; data: unknown[] }[];
  };
}

function chartOption() {
  return (testState.getOption() as ChartOption).baseOption;
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

  it("shows the selected window's summary and narrows it without refetching", () => {
    loaded(
      makePoints(44, (index) => {
        if (index === 42) return { descriptionEligibleHashes: 1000, describedHashes: 620 };
        if (index === 43) return { descriptionEligibleHashes: 1000, describedHashes: 780 };
        return {};
      }),
    );

    const view = renderCard();

    expect(view.getByRole("radio", { name: "90d" })).toBeChecked();
    expect(view.getByText("Jul 16 – Aug 28, 2026")).toBeInTheDocument();
    expect(view.getByText("700")).toBeInTheDocument();
    expect(view.getByText("Aug 28 · 4,300 fewer than Jul 16")).toBeInTheDocument();
    expect(view.getByText("5,346")).toBeInTheDocument();
    expect(view.getByText("88 skipped")).toBeInTheDocument();
    expect(view.getByText("5 failed")).toBeInTheDocument();
    expect(view.getByText("78%")).toBeInTheDocument();
    expect(view.getByText("+16 pts since Aug 27")).toBeInTheDocument();
    expect(view.getByRole("img").getAttribute("aria-label"))
      .toMatch(/^Attachment description backlog by day, Jul 16 to Aug 28, 2026\..*Coverage 78 percent/);
    expect(chartOption().series.find((series) => series.name === "Backlog")?.data).toHaveLength(44);

    fireEvent.click(view.getByRole("radio", { name: "30d" }));

    expect(view.getByText("Jul 30 – Aug 28, 2026")).toBeInTheDocument();
    expect(chartOption().series.find((series) => series.name === "Backlog")?.data).toHaveLength(30);
    expect(testState.refetch).not.toHaveBeenCalled();

    loaded(makePoints(44, () => ({ skipped: 0 })));

    expect(view.queryByText(/skipped/)).not.toBeInTheDocument();
    expect(view.getByText("3 failed")).toBeInTheDocument();

    loaded(makePoints(44, () => ({ failed: 0 })));

    expect(view.getByText("60 skipped")).toBeInTheDocument();
    expect(view.queryByText(/failed/)).not.toBeInTheDocument();
  });

  it("says when the window is empty and points to All", () => {
    // Every point is older than 30 days relative to the fake clock.
    loaded(makePoints(5));

    const view = renderCard();
    fireEvent.click(view.getByRole("radio", { name: "30d" }));

    expect(view.getByText(/No description runs recorded in the last 30 days\. Switch to All/))
      .toBeInTheDocument();
    expect(view.queryByTestId("history-chart")).not.toBeInTheDocument();

    fireEvent.click(view.getByRole("radio", { name: "All" }));

    expect(view.getByTestId("history-chart")).toBeInTheDocument();
  });

  it("details one day in the chart tooltip", () => {
    loaded(
      makePoints(44, (index) =>
        index === 43
          ? { queueDepth: null, failedRuns: 1, deferredRuns: 2, descriptionEligibleHashes: 1000, describedHashes: 780 }
          : { failedRuns: 0 }
      ),
    );
    renderCard();
    const tooltip = (day: number) =>
      chartOption().tooltip.formatter([{ axisValue: START_MS + day * DAY_MS }]).split("<br/>");

    expect(tooltip(0)).toEqual([
      "<strong>Jul 16, 2026</strong>",
      "Backlog: 5,000 files",
      "100 described · 2 skipped · 1 failed",
      "12 runs",
    ]);
    expect(tooltip(43)).toEqual([
      "<strong>Aug 28, 2026</strong>",
      "No backlog reading",
      "143 described · 2 skipped · 0 failed",
      "12 runs · 1 failed · 2 deferred",
      "Coverage: 78%",
    ]);
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
