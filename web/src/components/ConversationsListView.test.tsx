import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationListItem } from "../lib/api";
import { queryKeys } from "../lib/queries";
import { CONVERSATIONS_PAGE_SIZE } from "../lib/query-params";
import ConversationsListView from "./ConversationsListView";

const apiMocks = vi.hoisted(() => ({
  fetchConversations: vi.fn(),
  fetchConversationSources: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    fetchConversations: apiMocks.fetchConversations,
    fetchConversationSources: apiMocks.fetchConversationSources,
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
});
