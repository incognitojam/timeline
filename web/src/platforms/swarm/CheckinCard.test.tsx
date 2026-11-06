import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { EventGroupData } from "@shared/grouping";
import type { TimelineEvent } from "../../lib/types";
import CheckinCard from "./CheckinCard";

// Format a timestamp exactly like the component so assertions stay
// timezone-agnostic (the component uses the host locale/offset).
function fmt(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Minimal Swarm check-in event. Uses only generic placeholder data.
function makeCheckin(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: 1,
    source: "swarm",
    source_id: "checkin-1",
    source_account: "user",
    type: "location:visit",
    timestamp: "2026-07-10T10:20:00.000Z",
    end_timestamp: null,
    duration_ms: null,
    title: "Checked in at Central Station",
    content: null,
    latitude: 51.5,
    longitude: -0.1,
    location_name: "Central Station",
    people: null,
    tags: JSON.stringify(["Train Station"]),
    raw_data: "{}",
    imported_at: "2026-07-10T10:20:00.000Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

function singleGroup(event: TimelineEvent): EventGroupData<TimelineEvent> {
  const ts = event.timestamp as string;
  return {
    id: `single:${event.id}`,
    type: "single",
    source: "swarm",
    label: event.location_name ?? "Check-in",
    events: [event],
    summary: "1 check-in",
    timeRange: { start: ts, end: ts },
  };
}

function sessionGroup(events: TimelineEvent[]): EventGroupData<TimelineEvent> {
  return {
    id: "swarm:session:x",
    type: "session",
    source: "swarm",
    label: "Central Station",
    events,
    summary: `${events.length} check-ins`,
    timeRange: {
      start: events[0].timestamp as string,
      end: events[events.length - 1].timestamp as string,
    },
  };
}

describe("CheckinCard", () => {
  it("renders a single check-in with the venue as title, no 'Checked in at' and no '@' line", () => {
    const group = singleGroup(makeCheckin({}));
    const { getByText, queryByText, container } = render(() => (
      <CheckinCard group={group} />
    ));

    // Venue appears exactly once, as the title.
    expect(getByText("Central Station")).toBeInTheDocument();
    expect(queryByText(/Checked in at/)).not.toBeInTheDocument();
    // Category shows in the meta line.
    expect(getByText("· Train Station")).toBeInTheDocument();
    // No redundant "@ venue" location line.
    expect(container.textContent).not.toContain("@ Central Station");
  });

  it("falls back to a 'check-in' meta label when the check-in has no tags", () => {
    const group = singleGroup(makeCheckin({ tags: null }));
    const { getByText } = render(() => <CheckinCard group={group} />);
    expect(getByText("· check-in")).toBeInTheDocument();
  });

  it("renders a merged group with the parent venue once and nested venue lines", () => {
    const parent = makeCheckin({
      id: 1,
      timestamp: "2026-07-10T10:20:00.000Z",
      location_name: "Central Station",
      tags: JSON.stringify(["Train Station"]),
    });
    const child = makeCheckin({
      id: 2,
      source_id: "checkin-2",
      timestamp: "2026-07-10T10:25:00.000Z",
      title: "Checked in at Platform 2",
      location_name: "Platform 2",
      tags: JSON.stringify(["Platform"]),
    });
    const group = sessionGroup([parent, child]);
    const { getByText, getAllByText, container } = render(() => (
      <CheckinCard group={group} />
    ));

    // Parent venue rendered once.
    expect(getAllByText("Central Station")).toHaveLength(1);
    // Nested venue line present, with its time since the minute differs.
    expect(getByText("Platform 2")).toBeInTheDocument();
    const childTime = fmt(child.timestamp as string);
    expect(fmt(parent.timestamp as string)).not.toBe(childTime);
    expect(container.textContent).toContain(childTime);
  });

  it("omits the nested time when the minute matches the parent", () => {
    const parent = makeCheckin({
      id: 1,
      timestamp: "2026-07-10T10:20:10.000Z",
      location_name: "Central Station",
    });
    const child = makeCheckin({
      id: 2,
      source_id: "checkin-2",
      timestamp: "2026-07-10T10:20:40.000Z",
      location_name: "Platform 2",
    });
    const group = sessionGroup([parent, child]);
    const { getByText, container } = render(() => <CheckinCard group={group} />);

    expect(getByText("Platform 2")).toBeInTheDocument();
    // Both share a HH:MM — the shared label appears only in the parent time
    // column, never repeated on the nested row.
    const sharedTime = fmt(parent.timestamp as string);
    expect(fmt(child.timestamp as string)).toBe(sharedTime);
    expect(countOccurrences(container.textContent ?? "", sharedTime)).toBe(1);
  });

  it("renders a shout under its check-in", () => {
    const group = singleGroup(makeCheckin({ content: "Great coffee here" }));
    const { getByText } = render(() => <CheckinCard group={group} />);
    expect(getByText("Great coffee here")).toBeInTheDocument();
  });

  it("renders clickable companions", () => {
    const onPersonClick = vi.fn();
    const group = singleGroup(makeCheckin({ people: JSON.stringify(["Alice"]) }));
    const { getByText } = render(() => (
      <CheckinCard group={group} onPersonClick={onPersonClick} />
    ));
    const button = getByText("Alice");
    button.click();
    expect(onPersonClick).toHaveBeenCalledWith("Alice", "swarm", expect.anything());
  });
});
