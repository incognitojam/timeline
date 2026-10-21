import { fireEvent, render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import DayTimeline from "./DayTimeline";

const navigate = vi.fn();

vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchDayEvents: vi.fn(() => new Promise(() => {})), // never resolves
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
});
