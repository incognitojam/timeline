import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../lib/types";
import { SourceDeletedBadge, sourceDeletedClass, sourceDeletedTitle } from "./SourceDeletedBadge";

const baseEvent: TimelineEvent = {
  id: 1,
  source: "discord",
  source_id: "message-1",
  source_account: "test",
  type: "message:dm",
  timestamp: "2026-08-01T12:00:00.000Z",
  end_timestamp: null,
  duration_ms: null,
  title: "Test conversation",
  content: "hello",
  latitude: null,
  longitude: null,
  location_name: null,
  people: null,
  tags: null,
  raw_data: "{}",
  imported_at: "2026-08-01T12:00:00.000Z",
  import_batch: null,
  conversation_id: "conversation-1",
};

const deletedEvent: TimelineEvent = {
  ...baseEvent,
  source_deleted_observed_at: "2026-08-08T10:00:00.000Z",
};

describe("SourceDeletedBadge", () => {
  it("renders nothing for an event that still exists at the source", () => {
    const view = render(() => <SourceDeletedBadge event={baseEvent} />);
    expect(view.queryByText("deleted")).not.toBeInTheDocument();
  });

  it("labels a deleted event with when the deletion was noticed", () => {
    const view = render(() => <SourceDeletedBadge event={deletedEvent} />);
    const badge = view.getByText("deleted");
    const noticed = new Date("2026-08-08T10:00:00.000Z").toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    expect(badge).toHaveAttribute("title", `Deleted on Discord · noticed ${noticed}`);
  });
});

describe("sourceDeletedClass", () => {
  it("returns no classes for an ordinary event", () => {
    expect(sourceDeletedClass(baseEvent)).toBe("");
  });

  it("returns border and de-emphasis classes for a deleted event", () => {
    expect(sourceDeletedClass(deletedEvent)).toBe(" border-l-2 border-red-400/50 pl-2 opacity-70");
  });
});

describe("sourceDeletedTitle", () => {
  it("is undefined for an ordinary event", () => {
    expect(sourceDeletedTitle(baseEvent)).toBeUndefined();
  });
});
