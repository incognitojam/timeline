import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineEvent } from "../../lib/types";
import { clearCache, populateCache } from "../../lib/identities";
import CallRecordingCard from "./CallRecordingCard";

function recordingEvent(overrides: Partial<TimelineEvent> = {}, record: Record<string, unknown> = {}): TimelineEvent {
  return {
    id: 1,
    source: "call-recordings",
    source_id: "phone_20260315-181753_07700900123.amr",
    source_account: "owner",
    type: "recording:unknown",
    timestamp: "2026-06-02T12:11:35.000Z",
    end_timestamp: "2026-06-02T12:14:05.000Z",
    duration_ms: 150_000,
    title: "+447700900123",
    content: null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: JSON.stringify(["phone:+447700900123"]),
    tags: null,
    raw_data: JSON.stringify({
      file: "phone_20260315-181753_07700900123.amr",
      app: "phone",
      recorded_at: "20260315-181753",
      time_zone: "Europe/London",
      start_precision_s: 1,
      contact: "07700900123",
      number: "+447700900123",
      codec: "AMR-NB",
      playable: true,
      unplayable_reason: null,
      ...record,
    }),
    imported_at: "2026-06-02T14:00:00.000Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

describe("CallRecordingCard", () => {
  afterEach(() => clearCache());

  it("shows the call, who it was with, and the app it was in", () => {
    populateCache({ "phone:+447700900123": { name: "John Doe", username: null, contactId: 7, avatarUrl: null, isSelf: false } });
    const { getByText, container } = render(() => <CallRecordingCard event={recordingEvent()} />);
    expect(container.textContent).toContain("Phone call");
    expect(getByText("John Doe", { selector: "button" })).toBeTruthy();
  });

  it("names a recording placed by its call from the call's title, not its first person", () => {
    populateCache({ "phone:owner": { name: "Owner", username: null, contactId: 1, avatarUrl: null, isSelf: true } });
    const { getByText, queryByText } = render(() => (
      <CallRecordingCard
        event={recordingEvent(
          { type: "recording:unknown", title: "John Doe", people: JSON.stringify(["phone:owner", "phone:+447700900123"]) },
          { app: "facebook", contact: "08_53", number: null },
        )}
      />
    ));
    expect(getByText("John Doe", { selector: "p" })).toBeTruthy();
    expect(queryByText("Owner")).toBeNull();
    expect(queryByText("08_53")).toBeNull();
  });

  it("shows the call it recorded and opens that call's conversation", () => {
    const call = recordingEvent({ id: 2, source: "phone", type: "call:outgoing", duration_ms: 150_000, content: "2m 30s", raw_data: "{}" });
    const onOpenConversation = vi.fn();
    const { getByTitle } = render(() => (
      <CallRecordingCard event={recordingEvent()} linkedCalls={[call]} onOpenConversation={onOpenConversation} />
    ));
    const row = getByTitle("Open the conversation this call belongs to");
    expect(row.textContent).toContain("Outgoing call");
    fireEvent.click(row);
    expect(onOpenConversation).toHaveBeenCalledWith(call);
  });

  it("plays the stored playable copy, and says why when there is none", () => {
    const playable = render(() => <CallRecordingCard event={recordingEvent()} />);
    expect(playable.container.querySelector("audio")?.getAttribute("src")).toBe("/api/call-recordings/1/audio");
    playable.unmount();
    const amrOnly = render(() => (
      <CallRecordingCard event={recordingEvent({}, { playable: false, unplayable_reason: "afconvert is only available on macOS" })} />
    ));
    expect(amrOnly.container.querySelector("audio")).toBeNull();
    expect(amrOnly.container.textContent).toContain("Can't be played in a browser: afconvert is only available on macOS");
  });
});
