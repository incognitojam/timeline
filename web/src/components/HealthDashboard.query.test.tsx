import { formatHealthDateOnly } from "@shared/health-periods";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import type { EChartsOption } from "echarts";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthStats } from "../lib/api";
import HealthDashboard from "./HealthDashboard";

vi.mock("../ui/echarts", () => ({
  EChartsAutoSize: (props: { option: EChartsOption }) => {
    const snapshot = () => {
      const axis = props.option.xAxis as { data: string[]; axisLabel: { formatter: (date: string, index: number) => string } };
      return JSON.stringify({
        dates: axis.data,
        labels: axis.data.map(axis.axisLabel.formatter),
        grid: props.option.grid,
        series: props.option.series,
      });
    };
    return <div data-testid="chart">{snapshot()}</div>;
  },
}));

vi.mock("../lib/echarts-theme", () => ({
  useChartTheme: () => ({
    option: (option: unknown) => option,
    palette: () => ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"],
  }),
}));

function healthStats(avgSteps: number): HealthStats {
  return {
    dateRange: { start: "2026-07-01", end: "2026-07-31" },
    sleep: {
      avgDuration: 0,
      avgEfficiency: 0,
      avgBedtime: null,
      avgWakeTime: null,
      avgScore: 0,
      nightsTracked: 0,
      byDay: [],
      naps: [],
    },
    heart: { avgRestingHR: 0, byDay: [], rollingBaseline: [] },
    hrv: { avgRmssd: 0, byDay: [], rollingBaseline: [] },
    activity: {
      avgSteps,
      totalSteps: avgSteps,
      daysTracked: 1,
      byDay: [{ date: "2026-07-01", steps: avgSteps }],
    },
    spo2: { avgValue: 0, byDay: [], rollingBaseline: [] },
    weight: { latest: null, change: null, measurements: 0, byDay: [] },
  };
}

function renderDashboard(client: QueryClient, location: string) {
  const history = createMemoryHistory();
  history.set({ value: location, replace: true });

  return Object.assign(render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="/health" component={HealthDashboard} />
      </MemoryRouter>
    </QueryClientProvider>
  )), { history });
}

describe("HealthDashboard queries", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the dashboard mounted while loading but clears it after a period fails", async () => {
    let resolveJune: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/health/biomarkers") {
        return Promise.resolve(Response.json({
          biomarkers: [{
            id: "vitamin-example",
            name: "Vitamin Example",
            category: "Vitamins",
            results: [{
              date: "2026-07-01",
              value: 12,
              unit: "units",
              level: "normal",
              referenceRanges: [],
            }],
          }],
        }));
      }
      if (url.pathname === "/api/health/stats") {
        if (url.searchParams.get("anchor") === "2026-06-01") {
          return new Promise<Response>((resolve) => {
            resolveJune = resolve;
          });
        }
        return Promise.resolve(Response.json(healthStats(1_111)));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const view = renderDashboard(
      client,
      "/health?view=month&mode=calendar&anchor=2026-07-01",
    );

    expect(await view.findAllByText("1,111")).not.toHaveLength(0);
    fireEvent.click(view.getByTitle("Previous"));

    await waitFor(() => expect(resolveJune).toBeDefined());
    expect(view.getByText("Loading health data...")).toBeInTheDocument();
    expect(view.getAllByText("1,111")).not.toHaveLength(0);
    expect(view.container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    resolveJune?.(Response.json({ error: "Health unavailable" }, { status: 500 }));

    expect(await view.findByText("Failed to load health data for this period.")).toBeInTheDocument();
    expect(view.queryAllByText("1,111")).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Biomarkers" }));
    expect(await view.findByText("Vitamin Example")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Overview" }));
    fireEvent.click(view.getByTitle("Next"));
    expect(await view.findAllByText("1,111")).not.toHaveLength(0);

    const biomarkerRequests = fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input), "http://example.com").pathname === "/api/health/biomarkers");
    const statsRequests = fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input), "http://example.com").pathname === "/api/health/stats");
    expect(biomarkerRequests).toHaveLength(1);
    expect(statsRequests).toHaveLength(2);
    expect(statsRequests.map(([input]) => {
      const url = new URL(String(input), "http://example.com");
      return Object.fromEntries(url.searchParams);
    })).toEqual([
      { view: "month", mode: "calendar", anchor: "2026-07-01" },
      { view: "month", mode: "calendar", anchor: "2026-06-01" },
    ]);
  });

  it("updates an uncached period without unmounting its chart", async () => {
    let resolveJune: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/health/biomarkers") {
        return Promise.resolve(Response.json({ biomarkers: [] }));
      }
      if (url.pathname === "/api/health/stats") {
        if (url.searchParams.get("anchor") === "2026-06-01") {
          return new Promise<Response>((resolve) => {
            resolveJune = resolve;
          });
        }
        return Promise.resolve(Response.json(healthStats(1_111)));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderDashboard(
      client,
      "/health?view=month&mode=calendar&anchor=2026-07-01&section=activity",
    );

    expect(await view.findAllByText("1,111")).not.toHaveLength(0);
    expect(view.getAllByTestId("chart")).toHaveLength(1);
    const initialChart = view.getByTestId("chart");
    fireEvent.click(view.getByTitle("Previous"));

    await waitFor(() => expect(resolveJune).toBeDefined());
    expect(view.getAllByTestId("chart")).toHaveLength(1);
    expect(view.getByTestId("chart")).toBe(initialChart);
    expect(view.getAllByText("1,111")).not.toHaveLength(0);
    expect(view.getByRole("status")).toHaveTextContent("Loading health data...");

    resolveJune?.(Response.json(healthStats(2_222)));
    expect(await view.findAllByText("2,222")).not.toHaveLength(0);
    expect(view.queryAllByText("1,111")).toHaveLength(0);
    expect(view.getAllByTestId("chart")).toHaveLength(1);
    expect(view.getByTestId("chart")).toBe(initialChart);
    expect(view.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps labels, data and height together during delayed and cached view changes", async () => {
    const responses = new Map<string, (response: Response) => void>();
    const dataFor = (mode: string) => {
      const data = healthStats(mode === "week" ? 2222 : mode === "year" ? 3333 : 1111);
      const count = mode === "week" ? 7 : mode === "year" ? 12 : 31;
      data.activity.byDay = Array.from({ length: count }, (_, i) => ({
        date: new Date(Date.UTC(2026, mode === "year" ? i : 0, mode === "year" ? 15 : i + 1)).toISOString().slice(0, 10),
        steps: data.activity.avgSteps,
      }));
      return data;
    };
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/health/biomarkers") return Promise.resolve(Response.json({ biomarkers: [] }));
      if (url.pathname !== "/api/health/stats") throw new Error(`Unexpected request: ${url}`);
      const mode = url.searchParams.get("view") ?? "";
      if (mode === "month") return Promise.resolve(Response.json(dataFor(mode)));
      return new Promise<Response>(resolve => responses.set(mode, resolve));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const view = renderDashboard(client, `/health?view=month&mode=recent&anchor=${formatHealthDateOnly(new Date())}&section=activity`);
    await view.findByTestId("chart");
    const chart = view.getByTestId("chart");
    const region = view.getByRole("region", { name: "Date chart" });
    const initial = { content: chart.textContent, height: region.style.height };
    for (const mode of ["week", "year"]) {
      const previous = { content: chart.textContent, height: region.style.height };
      fireEvent.click(view.getByText(mode === "week" ? "Week" : "Year", { selector: "label" }));
      await waitFor(() => expect(responses.has(mode)).toBe(true));
      expect(chart.textContent).toBe(previous.content);
      expect(region.style.height).toBe(previous.height);
      expect(view.getByRole("status")).toHaveTextContent("Loading health data...");
      responses.get(mode)?.(Response.json(dataFor(mode)));
      await waitFor(() => expect(view.queryByRole("status")).not.toBeInTheDocument());
      const snapshot = JSON.parse(chart.textContent ?? "{}");
      expect(snapshot.dates).toHaveLength(mode === "week" ? 7 : 12);
      expect(snapshot.labels[0]).toBe(mode === "week" ? "Thu\n1\nJan" : "Jan");
      expect(snapshot.series[0].data[0]).toBe(mode === "week" ? 2222 : 3333);
      expect(view.getByTestId("chart")).toBe(chart);
    }
    fireEvent.click(view.getByText("Month", { selector: "label" }));
    await waitFor(() => expect(chart.textContent).toBe(initial.content));
    expect(region.style.height).toBe(initial.height);
    expect(view.getByTestId("chart")).toBe(chart);
  });

  it("resets calendar navigation to recent", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/health/biomarkers") {
        return Promise.resolve(Response.json({ biomarkers: [] }));
      }
      if (url.pathname === "/api/health/stats") {
        return Promise.resolve(Response.json(healthStats(4_444)));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderDashboard(
      client,
      "/health?view=month&mode=calendar&anchor=2026-07-01",
    );

    expect(await view.findAllByText("4,444")).not.toHaveLength(0);
    await waitFor(() => {
      expect(view.history.get()).toBe(
        "/health?view=month&mode=calendar&anchor=2026-07-01",
      );
    });

    const reset = view.getByRole("button", { name: "Reset to recent" });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    const anchor = formatHealthDateOnly(new Date());
    await waitFor(() => {
      expect(view.history.get()).toBe(`/health?view=month&mode=recent&anchor=${anchor}`);
      expect(reset).toBeDisabled();
    });
  });

  it("forwards a recent year into the current calendar year", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/health/biomarkers") {
        return Promise.resolve(Response.json({ biomarkers: [] }));
      }
      if (url.pathname === "/api/health/stats") {
        return Promise.resolve(Response.json(healthStats(5_555)));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderDashboard(
      client,
      "/health?view=year&mode=recent&anchor=2026-08-12",
    );

    expect(await view.findAllByText("5,555")).not.toHaveLength(0);
    const next = view.getByRole("button", { name: "Next period" });
    expect(next).toBeEnabled();
    fireEvent.click(next);

    await waitFor(() => {
      expect(view.history.get()).toBe(
        "/health?view=year&mode=calendar&anchor=2026-01-01",
      );
    });
    expect(next).toBeDisabled();
    expect(view.getByRole("button", { name: "Reset to recent" })).toBeEnabled();
  });

  it("shows biomarker failures without discarding successful period stats", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/health/biomarkers") {
        return Promise.resolve(Response.json(
          { error: "Biomarkers unavailable" },
          { status: 500 },
        ));
      }
      if (url.pathname === "/api/health/stats") {
        return Promise.resolve(Response.json(healthStats(2_222)));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderDashboard(
      client,
      "/health?view=month&mode=calendar&anchor=2026-07-01&section=biomarkers",
    );

    expect(await view.findByText("Failed to load biomarkers.")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Overview" }));
    expect(await view.findAllByText("2,222")).not.toHaveLength(0);
  });

  it("reports a failed same-period refresh while retaining cached stats", async () => {
    let statsRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/health/biomarkers") {
        return Promise.resolve(Response.json({ biomarkers: [] }));
      }
      if (url.pathname !== "/api/health/stats") {
        throw new Error(`Unexpected request: ${url}`);
      }
      statsRequests += 1;
      return Promise.resolve(statsRequests === 1
        ? Response.json(healthStats(3_333))
        : Response.json({ error: "Health unavailable" }, { status: 500 }));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderDashboard(
      client,
      "/health?view=month&mode=calendar&anchor=2026-07-01",
    );

    expect(await view.findAllByText("3,333")).not.toHaveLength(0);
    await client.refetchQueries({ queryKey: ["health", "stats"] });

    expect(await view.findByText(
      "Failed to refresh health data. Showing cached data for this period.",
    )).toBeInTheDocument();
    expect(view.getAllByText("3,333")).not.toHaveLength(0);
  });
});
