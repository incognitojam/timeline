import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineEvent } from "../../lib/types";
import { clearCache, populateCache } from "../../lib/identities";
import TimelineEventCard from "./TimelineEventCard";

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Minimal YouTube event as produced by the google-youtube parser:
// title = video title, content = channel name, people = [channel identity].
function makeYouTubeEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: 1,
    source: "youtube",
    source_id: "like-https://example.com/watch?v=abc-2026-07-10T10:20:00.000Z",
    source_account: "user",
    type: "youtube:like",
    timestamp: "2026-07-10T10:20:00.000Z",
    end_timestamp: null,
    duration_ms: null,
    title: "An Example Science Video",
    content: "Example Channel",
    latitude: null,
    longitude: null,
    location_name: null,
    people: JSON.stringify(["youtube:UCchannel1"]),
    tags: JSON.stringify(["like", "video", "has-channel"]),
    raw_data: "{}",
    imported_at: "2026-07-10T10:20:00.000Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

function seedChannelIdentity(name: string) {
  populateCache({
    "youtube:UCchannel1": { name, username: null, contactId: null, avatarUrl: null, isSelf: false },
  });
}

// jsdom has no layout, so clamping is simulated: an observed paragraph reports
// an overflowing scrollHeight only while the clamp class is applied.
function stubClamping(overflows: boolean) {
  class TestResizeObserver implements ResizeObserver {
    #callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }

    observe(target: Element) {
      const clamped = () => target.classList.contains("line-clamp-2");
      Object.defineProperty(target, "clientHeight", { configurable: true, get: () => 40 });
      Object.defineProperty(target, "scrollHeight", {
        configurable: true,
        get: () => (overflows && clamped() ? 120 : 40),
      });
      // Real observations are delivered after layout, so the clamp class is
      // already applied by the time the callback measures.
      queueMicrotask(() => this.#callback([], this));
    }

    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", TestResizeObserver);
}

describe("TimelineEventCard content expansion", () => {
  afterEach(() => {
    clearCache();
    vi.unstubAllGlobals();
  });

  const listen = () =>
    makeYouTubeEvent({
      source: "spotify",
      type: "listen:track",
      title: "A Song",
      content: "A Song by An Artist from An Album That Has A Rather Long Name Indeed",
      people: null,
    });

  it("offers no toggle when the content fits inside the clamp", async () => {
    stubClamping(false);
    const { queryByText } = render(() => <TimelineEventCard event={listen()} />);
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));

    expect(queryByText("Show more")).not.toBeInTheDocument();
  });

  it("toggles the clamp when the content is cut off", async () => {
    stubClamping(true);
    const { findByText, getByText, queryByText } = render(() => <TimelineEventCard event={listen()} />);

    const content = getByText("A Song by An Artist from An Album That Has A Rather Long Name Indeed");
    expect(content).toHaveClass("line-clamp-2");

    (await findByText("Show more")).click();
    expect(content).not.toHaveClass("line-clamp-2");

    getByText("Show less").click();
    expect(content).toHaveClass("line-clamp-2");
    expect(queryByText("Show more")).toBeInTheDocument();
  });
});

describe("TimelineEventCard youtube events", () => {
  afterEach(() => {
    clearCache();
  });

  it("shows the channel once, without angle brackets", () => {
    seedChannelIdentity("Example Channel");
    const { container, getByText } = render(() => (
      <TimelineEventCard event={makeYouTubeEvent({})} />
    ));

    expect(getByText("An Example Science Video")).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(countOccurrences(text, "Example Channel")).toBe(1);
    expect(text).not.toContain("<Example Channel>");
  });

  it("hides the sender line when it duplicates the title (subscribe events)", () => {
    seedChannelIdentity("Example Channel");
    const { container } = render(() => (
      <TimelineEventCard
        event={makeYouTubeEvent({
          type: "youtube:subscribe",
          title: "Example Channel",
          content: "Example Channel",
        })}
      />
    ));

    expect(countOccurrences(container.textContent ?? "", "Example Channel")).toBe(1);
  });

  it("keeps angle-bracket senders for message sources", () => {
    populateCache({
      "discord:123": { name: "Alice", username: null, contactId: null, avatarUrl: null, isSelf: false },
    });
    const { getByText } = render(() => (
      <TimelineEventCard
        event={makeYouTubeEvent({
          source: "discord",
          type: "message:dm",
          title: "alice",
          content: "hello there",
          people: JSON.stringify(["discord:123"]),
        })}
      />
    ));

    expect(getByText("<Alice>")).toBeInTheDocument();
    expect(getByText("hello there")).toBeInTheDocument();
  });
});

describe("TimelineEventCard self sender", () => {
  afterEach(() => {
    clearCache();
  });

  function seedSelf() {
    populateCache({
      "spotify:owner": { name: "Owner Example", username: null, contactId: 1, avatarUrl: null, isSelf: true },
    });
  }

  it("omits the sender line on the user's own activity", () => {
    seedSelf();
    const { container } = render(() => (
      <TimelineEventCard
        event={makeYouTubeEvent({
          source: "spotify",
          type: "listen:track",
          title: "A Song",
          content: "A Song by An Artist from An Album",
          people: JSON.stringify(["spotify:owner"]),
        })}
      />
    ));

    const text = container.textContent ?? "";
    expect(text).not.toContain("Owner Example");
    expect(text).toContain("A Song by An Artist from An Album");
  });

  it("names the user as \"You\" on their own messages", () => {
    populateCache({
      "discord:self": { name: "Owner Example", username: null, contactId: 1, avatarUrl: null, isSelf: true },
    });
    const { getByText, container } = render(() => (
      <TimelineEventCard
        event={makeYouTubeEvent({
          source: "discord",
          type: "message:dm",
          title: "alice",
          content: "see you tomorrow",
          people: JSON.stringify(["discord:self"]),
        })}
      />
    ));

    expect(getByText("<You>")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toContain("Owner Example");
  });
});
