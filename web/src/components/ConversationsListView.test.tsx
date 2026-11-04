import { createMemoryHistory, MemoryRouter, Route, useLocation } from "@solidjs/router";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentConversationListItem, ConversationListItem } from "../lib/api";
import { queryKeys } from "../lib/queries";
import { CONVERSATIONS_PAGE_SIZE } from "../lib/query-params";
import ConversationsListView, { CodingConversationsListView } from "./ConversationsListView";

const apiMocks = vi.hoisted(() => ({
  fetchConversations: vi.fn(),
  fetchConversationSources: vi.fn(),
  fetchCodingAgentConversations: vi.fn(),
  fetchCodingAgentConversationFilters: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchConversations: apiMocks.fetchConversations,
    fetchConversationSources: apiMocks.fetchConversationSources,
    fetchCodingAgentConversations: apiMocks.fetchCodingAgentConversations,
    fetchCodingAgentConversationFilters: apiMocks.fetchCodingAgentConversationFilters,
  };
});

const conversation: ConversationListItem = {
  source: "discord",
  sourceAccount: null,
  conversationId: "conversation-1",
  title: "Alice and Bob",
  messageCount: 42,
  firstMessage: "2026-07-01T10:00:00.000Z",
  lastMessage: "2026-07-02T10:00:00.000Z",
};

function createTestClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
}

function renderConversations(client: QueryClient, path = "/conversations") {
  const history = createMemoryHistory();
  history.set({ value: path, replace: true });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="/conversations"
          component={() => (
            <Suspense fallback={<div>Route fallback</div>}>
              <ConversationsListView />
            </Suspense>
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderRoutes(client: QueryClient, path: string) {
  const history = createMemoryHistory();
  history.set({ value: path, replace: true });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route path="/conversations" component={ConversationsListView} />
        <Route path="/coding/conversations" component={() => (<><CodingConversationsListView /><LocationProbe /></>)} />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

const codingConversation: CodingAgentConversationListItem = {
  source: "codex",
  sourceAccount: "local",
  conversationId: "codex-1",
  title: "Fix the build",
  messageCount: 12,
  firstMessage: "2026-07-01T10:00:00.000Z",
  lastMessage: "2026-07-02T10:00:00.000Z",
  project: "example-app",
};

describe("ConversationsListView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("keeps the page chrome and local skeleton outside the route Suspense fallback", () => {
    apiMocks.fetchConversations.mockImplementation(() => new Promise(() => {}));
    apiMocks.fetchConversationSources.mockImplementation(() => new Promise(() => {}));

    const view = renderConversations(createTestClient());

    expect(view.getByPlaceholderText("Search conversations...")).toBeInTheDocument();
    expect(view.getByRole("link", { name: "Servers" })).toBeInTheDocument();
    expect(view.getByRole("status", { name: "Loading conversations" })).toBeInTheDocument();
    expect(view.getByRole("option", { name: "Loading sources..." })).toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();
  });

  it("surfaces initial query failures instead of rendering an empty result", async () => {
    apiMocks.fetchConversations.mockRejectedValue(new Error("Conversations unavailable"));
    apiMocks.fetchConversationSources.mockRejectedValue(new Error("Sources unavailable"));

    const view = renderConversations(createTestClient());

    expect(await view.findByText("Failed to load conversations.")).toBeInTheDocument();
    expect(await view.findByText("Failed to load conversation sources.")).toBeInTheDocument();
    expect(view.queryByText("No conversations found.")).not.toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();
  });

  it("preserves the URL source selection while source options load", async () => {
    let resolveSources: ((value: { sources: string[] }) => void) | undefined;
    apiMocks.fetchConversations.mockResolvedValue({ conversations: [conversation], total: 1 });
    apiMocks.fetchConversationSources.mockImplementation(() => new Promise((resolve) => {
      resolveSources = resolve;
    }));

    const view = renderConversations(createTestClient(), "/conversations?source=discord");
    const sourceSelect = view.getByRole("combobox", { name: "Conversation source" });

    expect(sourceSelect).toHaveValue("discord");
    expect(view.getByRole("option", { name: "Discord" })).toBeInTheDocument();

    if (!resolveSources) throw new Error("Source query did not start");
    resolveSources({ sources: ["discord", "facebook"] });

    await view.findByRole("option", { name: "All sources" });
    expect(sourceSelect).toHaveValue("discord");
  });

  it("keeps placeholder rows visible while a filter request is pending", async () => {
    apiMocks.fetchConversations.mockImplementation(() => new Promise(() => {}));
    apiMocks.fetchConversationSources.mockImplementation(() => new Promise(() => {}));

    const client = createTestClient();
    client.setQueryData(
      queryKeys.conversations({
        search: undefined,
        source: undefined,
        limit: CONVERSATIONS_PAGE_SIZE,
        offset: 0,
      }),
      { conversations: [conversation], total: 1 },
    );
    client.setQueryData(queryKeys.conversationSources(), { sources: ["discord"] });

    const view = renderConversations(client);
    const searchInput = await view.findByPlaceholderText("Search conversations...");
    vi.useFakeTimers();
    fireEvent.input(searchInput, {
      target: { value: "Alice" },
    });
    await vi.advanceTimersByTimeAsync(300);

    expect(apiMocks.fetchConversations).toHaveBeenCalledWith({
      search: "Alice",
      source: undefined,
      limit: CONVERSATIONS_PAGE_SIZE,
      offset: 0,
      signal: expect.anything(),
    });
    expect(view.getByText("Alice and Bob")).toBeInTheDocument();
    expect(view.queryByRole("status", { name: "Loading conversations" })).not.toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();
    expect(view.container.querySelector("[aria-busy='true']")).toBeInTheDocument();
  });

  it("redirects old Messages links filtered to a coding agent to the Coding list", async () => {
    apiMocks.fetchCodingAgentConversations.mockResolvedValue({ conversations: [], total: 0 });
    apiMocks.fetchCodingAgentConversationFilters.mockResolvedValue({ sources: [], projects: [], unassigned: 0 });

    const view = renderRoutes(createTestClient(), "/conversations?source=claude-code&search=build");
    expect(await view.findByTestId("location")).toHaveTextContent("/coding/conversations?search=build&source=claude-code");
    expect(apiMocks.fetchConversations).not.toHaveBeenCalled();
  });

  it("filters coding agent sessions by project and the unassigned bucket", async () => {
    apiMocks.fetchCodingAgentConversations.mockResolvedValue({ conversations: [codingConversation], total: 1 });
    apiMocks.fetchCodingAgentConversationFilters.mockResolvedValue({
      sources: ["claude-code", "codex"],
      projects: [{ name: "example-app", count: 3 }],
      unassigned: 2,
    });

    const view = renderRoutes(createTestClient(), "/coding/conversations");

    expect(await view.findByText("Fix the build")).toBeInTheDocument();
    // Project shows on the row.
    expect(view.getByText("example-app")).toBeInTheDocument();

    const projectSelect = view.getByRole("combobox", { name: "Coding project" });
    await view.findByRole("option", { name: "example-app (3)" });
    expect(view.getByRole("option", { name: "No project (2)" })).toBeInTheDocument();

    fireEvent.change(projectSelect, { target: { value: "project:example-app" } });
    await vi.waitFor(() => {
      expect(apiMocks.fetchCodingAgentConversations).toHaveBeenLastCalledWith(expect.objectContaining({
        project: "example-app",
        unassigned: undefined,
        offset: 0,
      }));
    });
    expect(view.getByTestId("location")).toHaveTextContent("project=example-app");

    fireEvent.change(projectSelect, { target: { value: "unassigned" } });
    await vi.waitFor(() => {
      expect(apiMocks.fetchCodingAgentConversations).toHaveBeenLastCalledWith(expect.objectContaining({
        project: undefined,
        unassigned: true,
      }));
    });
    expect(view.getByTestId("location")).toHaveTextContent("unassigned=1");
  });

  it("updates project counts when the filters refresh", async () => {
    apiMocks.fetchCodingAgentConversations.mockResolvedValue({ conversations: [codingConversation], total: 1 });
    apiMocks.fetchCodingAgentConversationFilters.mockResolvedValue({
      sources: ["codex"], projects: [{ name: "example-app", count: 1 }], unassigned: 0,
    });
    const client = createTestClient();
    const view = renderRoutes(client, "/coding/conversations");
    await view.findByRole("option", { name: "example-app (1)" });

    client.setQueryData(queryKeys.codingAgentConversationFilters(), {
      sources: ["codex"], projects: [{ name: "example-app", count: 3 }], unassigned: 0,
    });
    expect(await view.findByRole("option", { name: "example-app (3)" })).toBeInTheDocument();
  });

  it("restores the project filter from the URL and keeps it once filters load", async () => {
    let resolveFilters: ((value: unknown) => void) | undefined;
    apiMocks.fetchCodingAgentConversations.mockResolvedValue({ conversations: [codingConversation], total: 1 });
    apiMocks.fetchCodingAgentConversationFilters.mockImplementation(() => new Promise((resolve) => {
      resolveFilters = resolve;
    }));

    const view = renderRoutes(createTestClient(), "/coding/conversations?project=example-app&source=codex");
    const projectSelect = view.getByRole("combobox", { name: "Coding project" });

    expect(projectSelect).toHaveValue("project:example-app");
    if (!resolveFilters) throw new Error("Filter query did not start");
    resolveFilters({ sources: ["codex"], projects: [{ name: "other-app", count: 4 }, { name: "example-app", count: 3 }], unassigned: 0 });
    await view.findByRole("option", { name: "example-app (3)" });
    expect(projectSelect).toHaveValue("project:example-app");
    await vi.waitFor(() => {
      expect(apiMocks.fetchCodingAgentConversations).toHaveBeenCalledWith(expect.objectContaining({
        project: "example-app",
        source: "codex",
      }));
    });
  });
});
