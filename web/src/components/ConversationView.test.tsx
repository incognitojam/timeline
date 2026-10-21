import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { Suspense } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
