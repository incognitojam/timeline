import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { render } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MessageScroller,
  MessageScrollerOptions,
} from "../../lib/createMessageScroller";
import type { TimelineEvent } from "../../lib/types";
import ConversationPane from "./ConversationPane";

const focusEvent: TimelineEvent = {
  id: 42,
  source: "example",
  source_id: "message-42",
  source_account: "test",
  type: "message:dm",
  timestamp: "2026-07-14T09:00:00.000Z",
  end_timestamp: null,
  duration_ms: null,
  title: "Test conversation",
  content: "First message of the day",
  latitude: null,
  longitude: null,
  location_name: null,
  people: null,
  tags: null,
  raw_data: "{}",
  imported_at: "2026-07-14T09:00:00.000Z",
  import_batch: null,
  conversation_id: "conversation-1",
};

vi.mock("../../lib/createMessageScroller", () => ({
  createMessageScroller: <T,>(options: MessageScrollerOptions<T>): MessageScroller<T> => {
    const scroller: MessageScroller<T> = {
      items: () => [focusEvent as T],
      isLoading: () => false,
      isLoadingBefore: () => false,
      isLoadingAfter: () => false,
      hasBefore: () => false,
      hasAfter: () => false,
      isAtEnd: () => true,
      error: () => null,
      viewportRef: () => undefined,
      topSentinelRef: () => undefined,
      bottomSentinelRef: () => undefined,
      scrollToEnd: () => undefined,
      scrollToStart: () => undefined,
      scrollToMessage: () => true,
    };
    options.onInitialLoad?.(scroller);
    return scroller;
  },
}));

describe("ConversationPane", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderPane() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const history = createMemoryHistory();
    history.set({ value: "/", replace: true });
    return render(() => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter history={history}>
          <Route
            path="/"
            component={() => (
              <ConversationPane
                pane={{
                  id: "pane-1",
                  conversationId: "conversation-1",
                  conversationTitle: "Test conversation",
                  conversationSource: "example",
                  conversationSourceAccount: "test",
                  focusEventId: focusEvent.id,
                }}
                onClose={() => undefined}
              />
            )}
          />
        </MemoryRouter>
      </QueryClientProvider>
    ));
  }

  it("keeps a highlighted first message visible beneath its date divider", () => {
    vi.useFakeTimers();
    const view = renderPane();

    const highlightedMessage = view.container.querySelector("#event-42");
    if (!highlightedMessage) throw new Error("Expected highlighted message");
    const messageGroup = highlightedMessage.parentElement;
    if (!messageGroup) throw new Error("Expected message group");

    expect(messageGroup.firstElementChild).toBe(highlightedMessage);
    expect(messageGroup.previousElementSibling).toHaveClass("sticky");
    expect(highlightedMessage).toHaveClass("ring-inset");

    view.unmount();
  });
});
