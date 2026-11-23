import { fireEvent, render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import DayTimeline from "./DayTimeline";
import { fetchDayEvents, fetchDayHealth } from "../../lib/api";
import { clearHiddenSources, toggleHiddenSource } from "../../lib/hiddenSourcesStore";
import type { TimelineEvent } from "../../lib/types";

const navigate = vi.fn();

vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDayEvents: vi.fn(() => new Promise(() => {})), // never resolves
    fetchDayHealth: vi.fn(() => new Promise(() => {})),
  };
});

describe("DayTimeline", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the day header immediately while events are still loading", async () => {
    const onOpenDatePicker = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { findByText, getByRole, getByText, getByTitle, queryByText } = render(() => (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div>Loading route...</div>}>
          <DayTimeline
            date="2026-07-07"
            onOpenDatePicker={onOpenDatePicker}
            showJournalToggle
            isJournalOpen={false}
            showSummaryToggle
            isSummaryOpen
            showMapToggle
            isMapOpen={false}
          />
        </Suspense>
      </QueryClientProvider>
    ));

    // Header chrome (date title, prev/next controls) renders without waiting
    // for the day events query to resolve.
    expect(getByText("Tuesday, July 7, 2026")).toBeInTheDocument();
    expect(getByTitle("Previous day")).toBeInTheDocument();
    expect(getByTitle("Next day")).toBeInTheDocument();
    expect(queryByText("Loading route...")).not.toBeInTheDocument();
    fireEvent.click(getByRole("button", { name: "Choose date, currently Tuesday, July 7, 2026" }));
    expect(onOpenDatePicker).toHaveBeenCalledOnce();
    expect(getByRole("button", { name: "Show journal" })).toHaveAttribute("aria-pressed", "false");
    expect(getByRole("button", { name: "Hide AI summary" })).toHaveAttribute("aria-pressed", "true");
    expect(getByRole("button", { name: "Show map" })).toHaveAttribute("aria-pressed", "false");

    // The event count in the header hasn't resolved yet (no full-page
    // fallback), but the timeline content area shows a loading affordance.
    expect(queryByText(/\d+ events/)).not.toBeInTheDocument();
    expect(await findByText("Loading events...")).toBeInTheDocument();
  });

  it("shows a recorded call inside its recording's card, unless either source is hidden", async () => {
    const base = {
      source_id: null, source_account: "owner", end_timestamp: null, latitude: null, longitude: null, location_name: null,
      tags: null, imported_at: "2026-07-07T12:00:00.000Z", import_batch: null, conversation_id: null, content: null,
    };
    const recordingEvent: TimelineEvent = {
      ...base, id: 1, source: "call-recordings", type: "recording:outgoing", timestamp: "2026-07-07T12:00:05.000Z",
      end_timestamp: "2026-07-07T12:10:00.000Z", duration_ms: 595_000, title: "Alice", people: JSON.stringify(["phone:+447700900123"]),
      raw_data: JSON.stringify({ file: "phone_20260707-130005.amr", app: "phone", start_precision_s: 1, number: null, playable: false, unplayable_reason: null }),
    };
    const callEvent: TimelineEvent = {
      ...base, id: 2, source: "phone", type: "call:outgoing", timestamp: "2026-07-07T12:00:00.000Z", duration_ms: 600_000,
      title: "Alice", content: "10m 0s", people: JSON.stringify(["phone:owner", "phone:+447700900123"]), raw_data: "{}", conversation_id: "+447700900123",
    };
    vi.mocked(fetchDayEvents).mockResolvedValue({
      date: "2026-07-07",
      centerTimestamp: "2026-07-07T12:00:00.000Z",
      events: [callEvent, recordingEvent],
      callLinks: { 1: [callEvent] },
      summary: { totalEvents: 2, bySource: [], byType: [], timeRange: { earliest: null, latest: null } },
    });
    vi.mocked(fetchDayHealth).mockResolvedValue({
      date: "2026-07-07", hasData: false, healthMetrics: {}, outOfRangeCount: 0, totalMetricCount: 0,
    });
    // Identity names are not what this checks.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ resolved: {} }), { status: 200 })));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { findByTitle, container, queryByTitle } = render(() => (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div>Loading route...</div>}>
          <DayTimeline date="2026-07-07" onOpenDatePicker={() => {}} />
        </Suspense>
      </QueryClientProvider>
    ));
    try {
      expect(await findByTitle("Open the conversation this call belongs to")).toBeInTheDocument();
      expect(container.querySelector("#event-2")).toBeNull();

      toggleHiddenSource("phone");
      expect(queryByTitle("Open the conversation this call belongs to")).toBeNull();
      expect(container.querySelector("#event-1")).not.toBeNull();

      toggleHiddenSource("phone");
      toggleHiddenSource("call-recordings");
      expect(container.querySelector("#event-1")).toBeNull();
      expect(container.textContent).toContain("Alice");
    } finally {
      clearHiddenSources();
      vi.unstubAllGlobals();
    }
  });
});

