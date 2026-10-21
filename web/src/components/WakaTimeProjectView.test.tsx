import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import WakaTimeProjectView from "./WakaTimeProjectView";

vi.mock("../lib/echarts-theme", () => ({
  useChartTheme: () => ({
    option: (option: unknown) => option,
    palette: () => ["#000000"],
  }),
}));

function renderProject(client: QueryClient) {
  const history = createMemoryHistory();
  history.set({ value: "/coding/example", replace: true });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="/coding/:name" component={WakaTimeProjectView} />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

function projectStats() {
  return {
    project: {
      name: "example",
      totalDuration: 60_000,
      sessionCount: 1,
      firstActivity: "2026-01-01T10:00:00.000Z",
      lastActivity: "2026-01-01T10:01:00.000Z",
    },
    byLanguage: [],
    byBranch: [],
    byDay: [],
    activityByMonth: [],
  };
}

function sessionPage(id: number, nextCursor: string | null) {
  return {
    sessions: [{
      id,
      timestamp: `2026-01-0${id}T10:00:00.000Z`,
      end_timestamp: `2026-01-0${id}T10:01:00.000Z`,
      duration_ms: 60_000,
      raw_data: null,
    }],
    count: 3,
    nextCursor,
  };
}

describe("WakaTimeProjectView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a list failure when the rest of the project loaded", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (url.pathname.endsWith("/sessions")) {
        return Promise.resolve(Response.json({ error: "Sessions unavailable" }, { status: 500 }));
      }
      if (url.pathname.endsWith("/conversations")) {
        return Promise.resolve(Response.json({ conversations: [], total: 0 }));
      }
      return Promise.resolve(Response.json(projectStats()));
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const view = renderProject(client);

    expect(await view.findByText("Failed to load sessions for this project")).toBeInTheDocument();
    expect(view.queryByText("No sessions found for this project")).not.toBeInTheDocument();
  });

  it("keeps retained pages visible and blocks load-more during a stale refetch", async () => {
    let backgroundRefetch = false;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input), "http://example.com");
      if (backgroundRefetch) {
        return new Promise<Response>(() => {});
      }
      if (url.pathname.endsWith("/sessions")) {
        return Promise.resolve(Response.json(
          url.searchParams.get("cursor") === "cursor-2"
            ? sessionPage(2, "cursor-3")
            : sessionPage(1, "cursor-2"),
        ));
      }
      if (url.pathname.endsWith("/conversations")) {
        return Promise.resolve(Response.json({ conversations: [], total: 0 }));
      }
      return Promise.resolve(Response.json(projectStats()));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });

    const firstVisit = renderProject(client);
    const firstLoadMore = await firstVisit.findByRole("button", { name: "Load more (2 remaining)" });
    fireEvent.click(firstLoadMore);
    await waitFor(() => expect(document.getElementById("event-2")).toBeInTheDocument());
    expect(firstVisit.getByRole("button", { name: "Load more (1 remaining)" })).toBeEnabled();
    cleanup();

    backgroundRefetch = true;
    const revisit = renderProject(client);
    const retainedLoadMore = await revisit.findByRole("button", { name: "Load more (1 remaining)" });

    expect(document.getElementById("event-1")).toBeInTheDocument();
    expect(document.getElementById("event-2")).toBeInTheDocument();
    await waitFor(() => expect(retainedLoadMore).toBeDisabled());
  });
});
