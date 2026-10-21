import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache } from "../../lib/identities";
import type { TimelineEvent } from "../../lib/types";
import { ConversationMessage } from "./ConversationMessage";

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 42,
    source: "example",
    source_id: "message-42",
    source_account: "test",
    type: "message:dm",
    timestamp: "2026-07-14T09:00:00.000Z",
    end_timestamp: null,
    duration_ms: null,
    title: "Test conversation",
    content: "Hello",
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: "{}",
    imported_at: "2026-07-14T09:00:00.000Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

function renderMessage(event: TimelineEvent, density: "full" | "compact" = "full") {
  return render(() => (
    <ConversationMessage
      event={event}
      conversationSource={event.source}
      attachments={[]}
      showSenderHeader
      density={density}
      highlighted={false}
      onPersonClick={() => undefined}
      onReplyJump={() => false}
    />
  ));
}

describe("ConversationMessage", () => {
  beforeEach(() => {
    // Both surfaces resolve identifiers, so every test here reaches the identity
    // endpoint; the ones that care about the response stub their own.
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ resolved: {} }), { status: 200 }),
      ),
    );
  });

  afterEach(() => {
    clearCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves its reactors on hover and names them by the contact that comes back", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          resolved: {
            "discord:111": { name: "Alice", username: null, contactId: 1, avatarUrl: null },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = renderMessage(makeEvent({
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [{
          emoji: { id: null, name: "🎉" },
          count: 2,
          users: [
            { id: "111", name: "alice_2019" },
            { id: "222", name: "bob_2019" },
          ],
        }],
      }),
    }));

    const tooltip = view.getByTitle("alice_2019, bob_2019");
    // Nothing is resolved until a reader goes looking for the names.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.mouseEnter(tooltip.parentElement as HTMLElement);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      identifiers: ["discord:111", "discord:222"],
    });

    // A reactor the server knows nothing about keeps the name captured with them.
    await vi.waitFor(() => {
      expect(view.getByTitle("Alice, bob_2019")).toBeInTheDocument();
    });
  });

  it("renders a Discord poll through the shared message surface", () => {
    const view = renderMessage(makeEvent({
      source: "discord",
      content: "Poll question",
      raw_data: JSON.stringify({
        poll: {
          question: { text: "Poll question" },
          answers: [{ answer_id: 1, poll_media: { text: "yes" } }],
          allow_multiselect: false,
        },
      }),
    }), "compact");

    expect(view.getByText("Poll question")).toBeInTheDocument();
    expect(view.getByText("yes")).toBeInTheDocument();
  });

  it("does not treat another source's raw poll key as a Discord poll", () => {
    const view = renderMessage(makeEvent({
      source: "facebook",
      raw_data: JSON.stringify({
        poll: {
          question: { text: "Poll question" },
          answers: [{ answer_id: 1, poll_media: { text: "yes" } }],
          allow_multiselect: false,
        },
      }),
    }));

    expect(view.queryByText("Poll question")).not.toBeInTheDocument();
  });

  it("shows call metadata in the compact surface", () => {
    const view = renderMessage(makeEvent({
      source: "facebook",
      type: "message:call",
      content: null,
      duration_ms: 61_000,
    }), "compact");

    expect(view.getByText("Call")).toBeInTheDocument();
    expect(view.getByText("(1m 1s)")).toBeInTheDocument();
  });

  it("keeps an Instagram media placeholder when the compact pane has no attachment row", () => {
    const view = renderMessage(
      makeEvent({
        source: "instagram",
        type: "message:dm:attachment",
        content: "[photo]",
      }),
      "compact",
    );

    expect(view.getByText("[photo]")).toBeInTheDocument();
  });

  it("marks a message with captured versions as edited", () => {
    const view = renderMessage(makeEvent({ version_count: 1 }));

    expect(view.getByText("(edited)")).toHaveAttribute(
      "title",
      "Edited · 1 earlier version captured",
    );
  });

  it("marks a source-deleted compact message while keeping its archived content", () => {
    const view = renderMessage(
      makeEvent({ source_deleted_observed_at: "2026-08-08T10:00:00.000Z" }),
      "compact",
    );

    expect(view.getByText("Hello")).toBeInTheDocument();
    expect(view.getByText("deleted")).toHaveClass("text-xs");
    expect(view.container.querySelector("#event-42 .flex-1")).toHaveClass(
      "border-l-2",
      "opacity-70",
    );
  });
});
