import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentDescriptionHistoryPoint,
  AttachmentDescriptionHistoryResponse,
  AttachmentsListResponse,
  AttachmentsStats,
} from "../lib/api";
import AttachmentsView from "./AttachmentsView";

vi.mock("../ui/echarts", () => ({
  EChartsAutoSize: () => <div data-testid="history-chart" />,
}));

vi.mock("../lib/echarts-theme", () => ({
  useChartTheme: () => ({
    option: (option: unknown) => option,
    palette: () => ["#625690", "#4c7c8c", "#8c7c4c", "#3d3560", "#2b2740", "#b4544c"],
  }),
}));

class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [];
  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
}

const STATS: AttachmentsStats = {
  total: 1234,
  byStatus: { pending: 3, stored: 1230, failed: 1, unrecoverable: 0 },
  distinctHashes: 1000,
  descriptionEligibleHashes: 500,
  describedHashes: 400,
  needingDescription: 100,
  byModel: [{ model: "test/model-a", count: 400 }],
  bySource: [
    { source: "discord", count: 800 },
    { source: "facebook", count: 434 },
    { source: "recall", count: 5000 },
  ],
};

const LIST: AttachmentsListResponse = {
  attachments: [
    {
      id: 1,
      eventId: 42,
      source: "discord",
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      fileSize: 2048,
      width: 800,
      height: 600,
      durationMs: null,
      storagePath: "media/photo.jpg",
      thumbhash: null,
      contentHash: "abc",
      status: "stored",
      timestamp: "2026-05-01T12:00:00Z",
      description: "A red bicycle",
      descriptionModel: "test/model-a",
    },
  ],
  nextCursor: null,
};

/**
 * Three synthetic daily points ending today, so the card's rolling 90-day
 * window contains them regardless of when the suite runs.
 */
function historyResponse(): AttachmentDescriptionHistoryResponse {
  const queueByDay = [1450, 1320, 1204];
  const points = queueByDay.map((queueDepth, index): AttachmentDescriptionHistoryPoint => ({
    date: new Date(Date.now() - (queueByDay.length - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    queueDepth,
    descriptionEligibleHashes: null,
    describedHashes: null,
    described: 120 - index * 20,
    skipped: 3,
    failed: index,
    runs: 48 - index * 4,
    failedRuns: 1,
    deferredRuns: 0,
  }));
  return { points };
}

function renderView(client: QueryClient) {
  const history = createMemoryHistory();
  history.set({ value: "/attachments", replace: true });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="/attachments"
          component={() => (
            <Suspense fallback={<div>Route fallback</div>}>
              <AttachmentsView />
            </Suspense>
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Stubs the attachment endpoints and returns the mock for URL assertions. */
function stubAttachmentsFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/attachments/stats")) return Promise.resolve(Response.json(STATS));
    if (url.includes("/api/attachments/description-history")) {
      return Promise.resolve(Response.json(historyResponse()));
    }
    return Promise.resolve(Response.json(LIST));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof stubAttachmentsFetch>;

/** `exclude_sources` on the most recent list request, or null if never sent. */
function latestExcludeSources(fetchMock: FetchMock): string | null {
  const listRequests = fetchMock.mock.calls
    .map(([input]) => new URL(String(input), "http://localhost"))
    .filter((url) => url.pathname === "/api/attachments");
  const latest = listRequests[listRequests.length - 1];
  return latest ? latest.searchParams.get("exclude_sources") : null;
}

function openSourceFilter(view: ReturnType<typeof renderView>) {
  fireEvent.click(view.getByRole("button", { name: /^Filter sources/ }));
}

describe("AttachmentsView", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
    vi.stubGlobal("scrollTo", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the header without suspending while data loads", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const view = renderView(newClient());

    expect(view.getByText("Attachments")).toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();
  });

  it("renders stats, source filter, and a month-grouped attachment tile", async () => {
    const fetchMock = stubAttachmentsFetch();

    const view = renderView(newClient());

    // Stats header: total + described breakdown + per-model chip
    expect(await view.findByText("1,234")).toBeInTheDocument();
    expect(view.getByText("400 / 500")).toBeInTheDocument();
    expect(view.getByText("80% of eligible files")).toBeInTheDocument();
    expect(view.getByText("test/model-a")).toBeInTheDocument();

    // Gallery filters use the shared, accessible segmented-control grammar.
    const mediaType = view.getByRole("radiogroup", { name: "Media type" });
    expect(within(mediaType).getByRole("radio", { name: "All" })).toBeChecked();
    expect(within(mediaType).getByRole("radio", { name: "Images" })).not.toBeChecked();
    expect(view.getByRole("radiogroup", { name: "Description status" })).toBeInTheDocument();

    // Recall is hidden by default, so the first list request excludes it
    expect(latestExcludeSources(fetchMock)).toBe("recall");

    // The shared source picker is populated from stats.bySource, including the
    // hidden recall row so it can be restored
    openSourceFilter(view);
    expect(view.getByRole("menuitemcheckbox", { name: /Discord/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(view.getByRole("menuitemcheckbox", { name: /Facebook/ })).toBeInTheDocument();
    expect(view.getByRole("menuitemcheckbox", { name: /Recall/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(view.getByText("800")).toBeInTheDocument();

    // Month header + tile links to the event page, description exposed via title
    expect(await view.findByText("May 2026")).toBeInTheDocument();
    const tile = view.getByTitle("A red bicycle");
    expect(tile).toHaveAttribute("href", "/event/42");
    expect(view.getByRole("img", { name: "photo.jpg" })).toHaveAttribute("loading", "lazy");
    expect(view.getByRole("img", { name: "photo.jpg" })).toHaveAttribute("fetchpriority", "low");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/attachments?limit=40"))).toBe(true);
  });

  it("shows the description history card between the stats header and the filters", async () => {
    stubAttachmentsFetch();

    const view = renderView(newClient());

    expect(view.getByText("Description backlog")).toBeInTheDocument();
    expect(view.getByRole("radio", { name: "90d" })).toBeChecked();

    // Latest end-of-day queue reading from the recorded history.
    expect(await view.findByText("1,204")).toBeInTheDocument();
    expect(view.getByTestId("history-chart")).toBeInTheDocument();

    // Coverage stays hidden while snapshot denominators are null.
    expect(view.queryByText("Eligible described")).not.toBeInTheDocument();
    expect(await view.findByText("80% of eligible files")).toBeInTheDocument();

    // The gallery below is unaffected.
    expect(await view.findByText("May 2026")).toBeInTheDocument();
  });

  it("keeps the gallery visible when description history fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/attachments/stats")) return Promise.resolve(Response.json(STATS));
        if (url.includes("/api/attachments/description-history")) {
          return Promise.resolve(Response.json({ error: "boom" }, { status: 500 }));
        }
        return Promise.resolve(Response.json(LIST));
      }),
    );

    const view = renderView(newClient());

    expect(await view.findByText("Could not load description history.")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(await view.findByText("May 2026")).toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();
  });

  it("keeps the gallery mounted while the attachment model list loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/summary/models") || /\/api\/attachments\/\d+$/.test(url)) {
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(Response.json(url.includes("/api/attachments/stats") ? STATS : LIST));
      }),
    );

    const view = renderView(newClient());
    const tile = await view.findByTitle("A red bicycle");

    fireEvent.click(tile);

    expect(document.querySelector("[role=dialog]")).toBeInTheDocument();
    expect(view.getByText("Attachments")).toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();
  });

  it("refetches with the sources hidden in the picker", async () => {
    const fetchMock = stubAttachmentsFetch();

    const view = renderView(newClient());
    expect(await view.findByText("May 2026")).toBeInTheDocument();

    openSourceFilter(view);

    // Un-hiding recall asks for every source explicitly
    fireEvent.click(view.getByRole("menuitemcheckbox", { name: /Recall/ }));
    await waitFor(() => expect(latestExcludeSources(fetchMock)).toBe(""));

    // Hiding another source excludes only that source
    fireEvent.click(view.getByRole("menuitemcheckbox", { name: /Discord/ }));
    await waitFor(() => expect(latestExcludeSources(fetchMock)).toBe("discord"));

    // Re-hiding recall keeps the existing exclusion, sorted for a stable key
    fireEvent.click(view.getByRole("menuitemcheckbox", { name: /Recall/ }));
    await waitFor(() => expect(latestExcludeSources(fetchMock)).toBe("discord,recall"));
  });

  it("clears every source exclusion from the picker", async () => {
    const fetchMock = stubAttachmentsFetch();

    const view = renderView(newClient());
    expect(await view.findByText("May 2026")).toBeInTheDocument();
    expect(latestExcludeSources(fetchMock)).toBe("recall");

    openSourceFilter(view);
    fireEvent.click(view.getByRole("menuitem", { name: "Clear all filters" }));

    await waitFor(() => expect(latestExcludeSources(fetchMock)).toBe(""));
    expect(view.getByRole("button", { name: "Filter sources" })).toBeInTheDocument();
    expect(
      view.queryByRole("menuitem", { name: "Clear all filters" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces attachment load failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/attachments/stats")) {
          return Promise.resolve(Response.json(STATS));
        }
        return Promise.resolve(Response.json({ error: "boom" }, { status: 500 }));
      }),
    );

    const view = renderView(newClient());

    expect(await view.findByText("Failed to load attachments.")).toBeInTheDocument();
  });
});
