import { fireEvent, render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queries";
import { INVALID_CONTACT_FILTER_MESSAGE, parseQuery } from "../lib/query-parser";
import { fetchSearch } from "../lib/api";
import type { ContactWithStats, TimelineEvent } from "../lib/types";
import SearchView from "./SearchView";

const navigate = vi.fn();
const setSearchParams = vi.fn();
const searchParams: { q: string; mode: string | undefined } = {
  q: "term",
  mode: undefined,
};

vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [searchParams, setSearchParams],
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchContacts: vi.fn(() => new Promise(() => {})),
    fetchSearch: vi.fn(() => new Promise(() => {})),
    fetchStats: vi.fn(() => new Promise(() => {})),
  };
});

vi.mock("../lib/identities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/identities")>();
  return {
    ...actual,
    navigateToIdentity: vi.fn(),
    resolveEventsIdentities: vi.fn(() => Promise.resolve()),
  };
});

class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [];
  disconnect() {}
  observe() {}
  takeRecords() { return []; }
  unobserve() {}
}

function makeEvent(id: number): TimelineEvent {
  return {
    id,
    source: "example",
    source_id: String(id),
    source_account: null,
    type: "example:event",
    timestamp: "2026-07-07T12:00:00.000Z",
    end_timestamp: null,
    duration_ms: null,
    title: `Event ${id}`,
    content: null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: "{}",
    imported_at: "2026-07-07T12:00:00.000Z",
    import_batch: null,
    conversation_id: null,
  };
}

function makeContact(
  id: number,
  displayName: string,
  options?: { hidden?: boolean; eventCount?: number },
): ContactWithStats {
  return {
    id,
    display_name: displayName,
    notes: null,
    date_of_birth: null,
    hidden: options?.hidden ? 1 : 0,
    is_self: 0,
    created_at: "2026-07-07T12:00:00.000Z",
    updated_at: "2026-07-07T12:00:00.000Z",
    identityCount: 1,
    eventCount: options?.eventCount ?? 12,
    avatarUrl: null,
  };
}

function createTestClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
}

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(fetchSearch).mockClear();
  searchParams.q = "term";
  searchParams.mode = undefined;
});

describe("SearchView", () => {
  it("links result titles to their destinations and dated results to their day", async () => {
    const queryClient = createTestClient();
    const events = [
      makeEvent(1),
      { ...makeEvent(2), source: "discord", type: "message:dm", conversation_id: "example/channel" },
      { ...makeEvent(3), source: "wakatime", type: "code:session", title: "Example project (1 hour)" },
      { ...makeEvent(4), type: "message:dm", timestamp: null },
    ];
    queryClient.setQueryData(
      queryKeys.searchEvents(parseQuery("term"), false),
      { pages: [{ events, count: events.length, nextCursor: null }], pageParams: [undefined] },
    );

    const { findByRole, getAllByRole } = render(() => (
      <QueryClientProvider client={queryClient}>
        <SearchView />
      </QueryClientProvider>
    ));

    expect(await findByRole("link", { name: "Event 1" })).toHaveAttribute("href", "/event/1");
    expect(await findByRole("link", { name: "Event 2" })).toHaveAttribute(
      "href", "/conversation/discord/example%2Fchannel#event-2",
    );
    expect(await findByRole("link", { name: "Example project (1 hour)" })).toHaveAttribute(
      "href", "/coding/project/Example%20project",
    );
    expect(await findByRole("link", { name: "Event 4" })).toHaveAttribute("href", "/event/4");
    const dayLinks = getAllByRole("link", { name: "this day" });
    expect(dayLinks).toHaveLength(3);
    for (const [index, link] of dayLinks.entries()) {
      expect(link).toHaveAttribute("href", `/?date=2026-07-07#event-${index + 1}`);
    }
  });

  it("keeps the search form visible while route-owned data is pending", () => {
    const queryClient = createTestClient();
    const { getByPlaceholderText, getByText, queryByText } = render(() => (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div>Loading route...</div>}>
          <SearchView />
        </Suspense>
      </QueryClientProvider>
    ));

    expect(getByPlaceholderText(/Search/)).toBeInTheDocument();
    expect(getByText("Loading results...")).toBeInTheDocument();
    expect(queryByText("Loading route...")).not.toBeInTheDocument();
  });

  it("flattens each keyword result page once per query update", async () => {
    const queryClient = createTestClient();
    let eventReads = 0;
    const page = {
      get events() {
        eventReads += 1;
        return [makeEvent(1), makeEvent(2)];
      },
      count: 2,
      nextCursor: null,
    };
    queryClient.setQueryData(
      queryKeys.searchEvents(parseQuery("term"), false),
      { pages: [page], pageParams: [undefined] },
    );
    eventReads = 0;

    const { findByText } = render(() => (
      <QueryClientProvider client={queryClient}>
        <SearchView />
      </QueryClientProvider>
    ));

    expect(await findByText("Event 1")).toBeInTheDocument();
    expect(await findByText("Event 2")).toBeInTheDocument();
    expect(eventReads).toBe(1);
  });

  it("renders the selected semantic result set", async () => {
    searchParams.mode = "semantic";
    const queryClient = createTestClient();
    queryClient.setQueryData(
      queryKeys.semanticSearch({ q: "term", includeNoisySources: false }),
      { events: [{ ...makeEvent(3), distance: 0.125 }], count: 1 },
    );

    const { findByText } = render(() => (
      <QueryClientProvider client={queryClient}>
        <SearchView />
      </QueryClientProvider>
    ));

    expect(await findByText("Event 3")).toBeInTheDocument();
    expect(await findByText("0.125")).toBeInTheDocument();
  });

  it("suggests a contact by name and keeps its stable ID in the query", async () => {
    const queryClient = createTestClient();
    queryClient.setQueryData(
      queryKeys.contacts({ includeHidden: true }),
      [makeContact(42, "Alice Example")],
    );

    const { findByRole, findByText, getByPlaceholderText } = render(() => (
      <QueryClientProvider client={queryClient}>
        <SearchView />
      </QueryClientProvider>
    ));

    const input = getByPlaceholderText(/Search/);
    fireEvent.input(input, { target: { value: "contact:ali" } });

    const option = await findByRole("option", { name: /Alice Example.*12 events/ });
    fireEvent.mouseDown(option);

    expect(input).toHaveValue("contact:42 ");
    expect(await findByText("Contact · Alice Example")).toBeInTheDocument();
  });

  it("guides invalid contact text without issuing a search request", () => {
    searchParams.q = "contact:Alice";
    const queryClient = createTestClient();
    queryClient.setQueryData(
      queryKeys.contacts({ includeHidden: true }),
      [makeContact(42, "Alice Example")],
    );
    queryClient.setQueryData(
      queryKeys.searchEvents(parseQuery("contact:Alice"), false),
      {
        pages: [{ events: [makeEvent(9)], count: 1, nextCursor: null }],
        pageParams: [undefined],
      },
    );

    const { getByPlaceholderText, getByRole, getByText, queryByText } = render(() => (
      <QueryClientProvider client={queryClient}>
        <SearchView />
      </QueryClientProvider>
    ));

    const input = getByPlaceholderText(/Search/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(getByRole("alert")).toHaveTextContent(INVALID_CONTACT_FILTER_MESSAGE);
    expect(getByText("Invalid contact")).toBeInTheDocument();
    expect(queryByText("Event 9")).not.toBeInTheDocument();
    const form = input.closest("form");
    if (!form) throw new Error("Expected search input inside a form");
    fireEvent.submit(form);
    expect(fetchSearch).not.toHaveBeenCalled();
  });

  it("lets Tab leave an unselected autocomplete list", () => {
    searchParams.q = "";
    const queryClient = createTestClient();
    const { getByPlaceholderText, queryByRole } = render(() => (
      <QueryClientProvider client={queryClient}>
        <SearchView />
      </QueryClientProvider>
    ));

    const input = getByPlaceholderText(/Search/);
    fireEvent.focus(input);
    expect(queryByRole("listbox")).toBeInTheDocument();

    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
    expect(input).toHaveValue("");
    expect(queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("clears the active suggestion when the cursor moves to another token", () => {
    searchParams.q = "sort: date:";
    const queryClient = createTestClient();
    const { getByPlaceholderText } = render(() => (
      <QueryClientProvider client={queryClient}>
        <SearchView />
      </QueryClientProvider>
    ));

    const input = getByPlaceholderText(/Search/) as HTMLInputElement;
    fireEvent.focus(input);
    input.setSelectionRange("sort:".length, "sort:".length);
    fireEvent.click(input);
    for (let index = 0; index < 4; index += 1) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    }
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "search-autocomplete-option-3",
    );

    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.click(input);

    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
    expect(input).toHaveValue("sort: date:");
  });
});
