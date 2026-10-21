import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../lib/types";
import { EditedBadge, editedTitle } from "./EditedBadge";

const baseEvent: TimelineEvent = {
  id: 1,
  source: "discord",
  source_id: "m1",
  source_account: "test",
  type: "message:dm",
  timestamp: "2026-08-01T09:00:00.000Z",
  end_timestamp: null,
  duration_ms: null,
  title: "Chat",
  content: "Hello",
  latitude: null,
  longitude: null,
  location_name: null,
  people: null,
  tags: null,
  raw_data: "{}",
  imported_at: "2026-08-01T09:00:00.000Z",
  import_batch: null,
  conversation_id: null,
};

const editedEvent: TimelineEvent = { ...baseEvent, version_count: 2 };

describe("EditedBadge", () => {
  it("renders nothing without captured versions", () => {
    const view = render(() => <EditedBadge event={baseEvent} />);
    expect(view.queryByText("(edited)")).not.toBeInTheDocument();
  });

  it("marks events with captured versions", () => {
    const view = render(() => <EditedBadge event={editedEvent} />);
    const badge = view.getByText("(edited)");
    expect(badge).toHaveAttribute("title", "Edited · 2 earlier versions captured");
  });

  it("uses singular wording for a single captured version", () => {
    expect(editedTitle({ ...baseEvent, version_count: 1 })).toBe(
      "Edited · 1 earlier version captured",
    );
  });
});
