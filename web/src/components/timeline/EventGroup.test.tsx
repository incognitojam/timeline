import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupEvents } from "@shared/grouping";
import { clearCache, populateCacheFromParticipants } from "../../lib/identities";
import type { TimelineEvent } from "../../lib/types";
import EventGroup from "./EventGroup";

// Format a timestamp exactly like the component so assertions stay
// timezone-agnostic (the component uses the host locale/offset).
function fmt(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Minimal Discord message event. Uses only generic placeholder data.
function makeMessage(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: 1,
    source: "discord",
    source_id: "msg-1",
    source_account: "user",
    type: "message:group",
    timestamp: "2026-07-10T10:20:00.000Z",
    end_timestamp: null,
    duration_ms: null,
    title: "Example Server #general",
    content: "are we still on for tomorrow?",
    latitude: null,
    longitude: null,
    location_name: null,
    people: JSON.stringify(["Alice"]),
    tags: null,
    raw_data: "{}",
    imported_at: "2026-07-10T10:20:00.000Z",
    import_batch: null,
    conversation_id: "100000000000000001",
    ...overrides,
  };
}

describe("EventGroup conversation cards", () => {
  afterEach(clearCache);

  it.each([1, 7])("shows a DM name once for %i messages and still opens the conversation", (count) => {
    populateCacheFromParticipants({
      "discord:alice": { name: "Alice", contactId: null, avatarUrl: null, isSelf: false },
    });
    const groups = groupEvents(Array.from({ length: count }, (_, index) => makeMessage({
      id: index + 1,
      source_id: `msg-${index + 1}`,
      type: "message:dm",
      title: "Alice",
      people: JSON.stringify(["discord:alice"]),
      timestamp: new Date(Date.UTC(2026, 6, 10, 10, 20 + index)).toISOString(),
    })));
    const onOpenInWorkspace = vi.fn();
    const { getAllByText, getByRole, container } = render(() => (
      <EventGroup group={groups[0]} onOpenInWorkspace={onOpenInWorkspace} />
    ));

    expect(getAllByText("Alice", { exact: true })).toHaveLength(1);
    if (count > 1) {
      expect(container.textContent).toContain("7 messages");
      expect(container.textContent).toContain(`${fmt(groups[0].timeRange.start!)} - ${fmt(groups[0].timeRange.end!)}`);
    } else {
      expect(container.textContent).not.toContain("1 message");
    }
    fireEvent.click(getByRole("button"));
    expect(onOpenInWorkspace).toHaveBeenCalledWith(groups[0].events[0]);
  });

  it("removes the duplicate participant row when an identity resolves after rendering", () => {
    const groups = groupEvents([makeMessage({
      type: "message:dm", title: "Alice", people: JSON.stringify(["discord:alice"]),
    })]);
    const { getAllByText, queryByText } = render(() => <EventGroup group={groups[0]} />);
    expect(queryByText("alice")).toBeInTheDocument();

    populateCacheFromParticipants({
      "discord:alice": { name: "Alice", contactId: null, avatarUrl: null, isSelf: false },
    });

    expect(queryByText("alice")).not.toBeInTheDocument();
    expect(getAllByText("Alice", { exact: true })).toHaveLength(1);
  });

  it("keeps the participant row when a DM has another sender", () => {
    const groups = groupEvents([
      makeMessage({ id: 1, type: "message:dm", title: "Alice" }),
      makeMessage({ id: 2, source_id: "msg-2", type: "message:dm", title: "Alice", people: JSON.stringify(["Bob"]) }),
    ]);
    const { getByText } = render(() => <EventGroup group={groups[0]} />);
    expect(getByText("Alice, Bob")).toBeInTheDocument();
  });

  it("shows the thread and sender alone for a one-message conversation", () => {
    const groups = groupEvents([makeMessage({})]);
    expect(groups.length).toBe(1);

    const { container } = render(() => <EventGroup group={groups[0]} />);

    expect(container.textContent).toContain("Example Server #general");
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).not.toContain("1 message");
  });

  it("keeps the count and range for a multi-message conversation", () => {
    const groups = groupEvents([
      makeMessage({ id: 1 }),
      makeMessage({ id: 2, source_id: "msg-2", timestamp: "2026-07-10T10:25:00.000Z" }),
    ]);
    expect(groups.length).toBe(1);

    const { container } = render(() => <EventGroup group={groups[0]} />);

    expect(container.textContent).toContain("2 messages");
    expect(container.textContent).toContain(`${fmt("2026-07-10T10:20:00.000Z")} - ${fmt("2026-07-10T10:25:00.000Z")}`);
  });
});
