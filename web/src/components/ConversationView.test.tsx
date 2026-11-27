import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queries";
import type { TimelineEvent } from "../lib/types";
import ConversationView from "./ConversationView";

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

function renderConversation(client: QueryClient) {
  const history = createMemoryHistory();
  history.set({
    value: "/conversation/discord/conversation-1",
    replace: true,
  });

  return render(() => (
    <QueryClientProvider client={client}>
      <MemoryRouter history={history}>
        <Route
          path="/conversation/:source/:conversationId"
          component={() => (
            <Suspense fallback={<div>Route fallback</div>}>
              <ConversationView />
            </Suspense>
          )}
        />
      </MemoryRouter>
    </QueryClientProvider>
  ));
}

describe("ConversationView", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps its page chrome visible while messages and stats are pending", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL) => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = renderConversation(client);

    expect(view.getByRole("heading", { name: "Discord" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Info" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Media" })).toBeInTheDocument();
    expect(view.getByText("Loading conversation...")).toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "Media" }));

    expect(view.getByRole("button", { name: "Images" })).toBeInTheDocument();
    expect(view.getByText("Loading conversation...")).toBeInTheDocument();
    expect(view.queryByText("Route fallback")).not.toBeInTheDocument();

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes("/api/conversation?"))).toBe(true);
      expect(urls.some((url) => url.includes("/api/conversation/stats?"))).toBe(true);
      expect(urls.some((url) => url.includes("/api/conversation/media?"))).toBe(true);
    });
  });

  it("marks a source-deleted message but keeps its content", async () => {
    const deletedEvent: TimelineEvent = {
      id: 9001,
      source: "discord",
      source_id: "message-9001",
      source_account: "test",
      type: "message:dm",
      timestamp: "2026-08-01T12:00:00.000Z",
      end_timestamp: null,
      duration_ms: null,
      title: "Test conversation",
      content: "hello from the archive",
      latitude: null,
      longitude: null,
      location_name: null,
      people: null,
      tags: null,
      raw_data: "{}",
      imported_at: "2026-08-01T12:00:00.000Z",
      import_batch: null,
      conversation_id: "conversation-1",
      source_deleted_observed_at: "2026-08-08T10:00:00.000Z",
    };
    const jsonResponse = (body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/conversation?")) {
        return jsonResponse({
          title: "Test conversation",
          events: [deletedEvent],
          nextCursor: null,
          server: null,
        });
      }
      if (url.includes("/api/conversation/stats?")) {
        return jsonResponse({
          totalMessages: 1,
          firstMessage: deletedEvent.timestamp,
          lastMessage: deletedEvent.timestamp,
          firstEventId: deletedEvent.id,
          lastEventId: deletedEvent.id,
          participants: [],
          attachmentCount: 0,
          activityByMonth: [],
          titles: [],
          tokenUsage: null,
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = renderConversation(client);

    expect(await view.findByText("hello from the archive")).toBeInTheDocument();
    expect(view.getByText("deleted")).toBeInTheDocument();
    expect(view.container.querySelector("#event-9001 .flex-1")).toHaveClass("border-l-2", "opacity-70");
  });
  it("takes its header and tab title from a cached list row until the messages load", async () => {
    let respond: (response: Response) => void = () => {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => String(input).includes("/api/conversation?")
      ? new Promise<Response>((resolve) => { respond = resolve; })
      : new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.conversations({ scope: "messages", limit: 50, offset: 0 }), {
      conversations: [listedConversation("Study Group")],
      total: 1,
    });

    const view = renderConversation(client);
    expect(view.getByRole("heading", { name: "Study Group" })).toBeInTheDocument();
    expect(document.title).toBe("Study Group · Timeline");
    // The row's message count is the conversation's total, not what is loaded.
    expect(view.queryByText(/messages loaded/)).not.toBeInTheDocument();
    expect(view.getByRole("status", { name: "Loading conversation" })).toBeInTheDocument();

    respond(Response.json({ title: "Study Group (renamed)", events: [], nextCursor: null, server: null }));
    expect(await view.findByRole("heading", { name: "Study Group (renamed)" })).toBeInTheDocument();
    expect(view.getByText(/messages loaded/)).toHaveTextContent("0 messages loaded");
  });

  it("shows no message count when the first page fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).includes("/api/conversation?")
      ? Promise.resolve(new Response("boom", { status: 500 }))
      : new Promise<Response>(() => {})));
    vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.conversations({ scope: "messages", limit: 50, offset: 0 }), {
      conversations: [listedConversation("Study Group")],
      total: 1,
    });

    const view = renderConversation(client);
    expect(await view.findByText(/^Error:/)).toBeInTheDocument();
    expect(view.getByRole("heading", { name: "Study Group" })).toBeInTheDocument();
    expect(view.queryByText(/messages loaded/)).not.toBeInTheDocument();
  });

  it("takes the title from the most recently fetched list holding the conversation", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.conversations({ scope: "messages", limit: 50, offset: 0 }), {
      conversations: [listedConversation("Old Name")], total: 1,
    }, { updatedAt: 1_000 });
    client.setQueryData(queryKeys.conversations({ scope: "messages", search: "new", limit: 50, offset: 0 }), {
      conversations: [listedConversation("New Name")], total: 1,
    }, { updatedAt: 2_000 });

    const view = renderConversation(client);
    expect(view.getByRole("heading", { name: "New Name" })).toBeInTheDocument();
  });

  it("ignores a cached list row once its list is invalidated", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queryKeys.contactConversations(7), { conversations: [listedConversation("Hidden Friend")] });
    // Hiding a contact invalidates every query.
    await client.invalidateQueries();

    const view = renderConversation(client);
    expect(view.getByRole("heading", { name: "Discord" })).toBeInTheDocument();
    expect(view.queryByText("Hidden Friend")).not.toBeInTheDocument();
  });
});

function listedConversation(title: string) {
  return {
    source: "discord", sourceAccount: null, conversationId: "conversation-1", title,
    messageCount: 42, firstMessage: "2026-01-01T10:00:00.000Z", lastMessage: "2026-03-01T10:00:00.000Z",
  };
}
