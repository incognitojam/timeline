import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WakaTimeStats } from "../lib/api";
import WakaTimeOverview from "./WakaTimeOverview";

vi.mock("../ui/echarts", () => ({
  EChartsAutoSize: () => <div data-testid="chart" />,
}));

vi.mock("../lib/echarts-theme", () => ({
  useChartTheme: () => ({
    option: (option: unknown) => option,
    palette: () => ["#111111"],
  }),
}));

function wakaTimeStats(sessionCount: number): WakaTimeStats {
  return {
    totalDuration: 60_000,
    sessionCount,
    avgSessionDuration: 60_000,
    dateRange: { start: "2026-07-01", end: "2026-07-07" },
    byProject: [],
    byLanguage: [],
    byBranch: [],
    byDay: [],
  };
}

function codingProjects() {
  return {
    projects: [{
      name: "Example Project",
      primaryLanguage: "TypeScript",
      totalDuration: 60_000,
      sessionCount: 1,
      conversationCount: 0,
      messageCount: 0,
      aiSources: [],
      firstActivity: "2026-07-01",
      lastActivity: "2026-07-07",
    }],
  };
}

function renderOverview(client: QueryClient) {
  const history = createMemoryHistory();
  history.set({ value: "/coding", replace: true });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="/coding" component={WakaTimeOverview} />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

describe("WakaTimeOverview", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keys stats by preset without refetching the invariant project list", async () => {
    let resolveThirtyDays: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/coding/projects") {
        return Promise.resolve(Response.json(codingProjects()));
      }
      if (url.pathname === "/api/wakatime/stats") {
        if (url.searchParams.get("preset") === "30d") {
          return new Promise<Response>((resolve) => {
            resolveThirtyDays = resolve;
          });
        }
        return Promise.resolve(Response.json(wakaTimeStats(11)));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const view = renderOverview(client);

    expect(await view.findByText("11")).toBeInTheDocument();
    expect(await view.findByText("Example Project")).toBeInTheDocument();

    fireEvent.click(view.getByRole("radio", { name: "Last 30 Days" }));
    await waitFor(() => expect(resolveThirtyDays).toBeDefined());
    expect(view.getByText("Loading coding activity...")).toBeInTheDocument();
    expect(view.queryByText("11")).not.toBeInTheDocument();
    resolveThirtyDays?.(Response.json({ error: "Stats unavailable" }, { status: 500 }));

    expect(await view.findByText("Failed to load coding activity for this period.")).toBeInTheDocument();
    expect(view.queryByText("11")).not.toBeInTheDocument();
    expect(view.getByText("Example Project")).toBeInTheDocument();

    fireEvent.click(view.getByRole("radio", { name: "Last 7 Days" }));
    expect(await view.findByText("11")).toBeInTheDocument();

    const projectRequests = fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input), "http://example.com").pathname === "/api/coding/projects");
    const statsRequests = fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input), "http://example.com").pathname === "/api/wakatime/stats");
    expect(projectRequests).toHaveLength(1);
    expect(statsRequests).toHaveLength(2);
  });

  it("shows a project-list error without discarding successful stats", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/coding/projects") {
        return Promise.resolve(Response.json(
          { error: "Projects unavailable" },
          { status: 500 },
        ));
      }
      if (url.pathname === "/api/wakatime/stats") {
        return Promise.resolve(Response.json(wakaTimeStats(22)));
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderOverview(client);

    expect(await view.findByText("22")).toBeInTheDocument();
    expect(await view.findByText("Failed to load coding projects.")).toBeInTheDocument();
    expect(view.queryByText("No projects found")).not.toBeInTheDocument();
  });

  it("reports a failed same-preset refresh while retaining cached stats", async () => {
    let statsRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname === "/api/coding/projects") {
        return Promise.resolve(Response.json(codingProjects()));
      }
      if (url.pathname !== "/api/wakatime/stats") {
        throw new Error(`Unexpected request: ${url}`);
      }
      statsRequests += 1;
      return Promise.resolve(statsRequests === 1
        ? Response.json(wakaTimeStats(33))
        : Response.json({ error: "Stats unavailable" }, { status: 500 }));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderOverview(client);

    expect(await view.findByText("33")).toBeInTheDocument();
    await client.refetchQueries({ queryKey: ["coding", "stats"] });

    expect(await view.findByText(
      "Failed to refresh coding activity. Showing cached data for this period.",
    )).toBeInTheDocument();
    expect(view.getByText("33")).toBeInTheDocument();
  });
});
