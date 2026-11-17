import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineEvent } from "../../lib/types";
import { clearCache, populateCache } from "../../lib/identities";
import CallRecordingCard from "./CallRecordingCard";

const TRANSCRIPT = [
  "# Call with: Alice (2 Jun 2026, 13:11)",
  "",
  "13:11 <Alice> Hello?",
  "",
  "13:12 <Bob> Hi, it's me.",
  "",
  "13:12 <Alice> Are we still on for Saturday?",
  "",
  "13:13 <Bob> Yes, see you then.",
].join("\n");

function recordingEvent(overrides: Partial<TimelineEvent> = {}, record: Record<string, unknown> = {}): TimelineEvent {
  return {
    id: 1,
    source: "call-recordings",
    source_id: "Call_20260602-131135",
    source_account: "owner",
    type: "recording:outgoing",
    timestamp: "2026-06-02T12:11:35.000Z",
    end_timestamp: "2026-06-02T12:14:05.000Z",
    duration_ms: 150_000,
    title: "+447700900123",
    content: TRANSCRIPT,
    latitude: null,
    longitude: null,
    location_name: null,
    people: JSON.stringify(["phone:+447700900123"]),
    tags: null,
    raw_data: JSON.stringify({ id: "Call_20260602-131135", source: "phone", start: "2026-06-02T13:11:35+01:00", recorded_sides: "both_expected", ...record }),
    imported_at: "2026-06-02T14:00:00.000Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

describe("CallRecordingCard", () => {
  afterEach(() => clearCache());

  it("shows the call, who it was with, and a transcript preview that expands", () => {
    populateCache({ "phone:+447700900123": { name: "Alice", username: null, contactId: 7, avatarUrl: null, isSelf: false } });
    const { getByText, queryByText, container } = render(() => <CallRecordingCard event={recordingEvent()} />);
    expect(container.textContent).toContain("Outgoing phone call");
    expect(container.textContent).toContain("Both sides recorded");
    expect(getByText("Alice", { selector: "button" })).toBeTruthy();
    expect(getByText("Are we still on for Saturday?")).toBeTruthy();
    expect(queryByText("Yes, see you then.")).toBeNull();
    fireEvent.click(getByText("Show full transcript (4 turns)"));
    expect(getByText("Yes, see you then.")).toBeTruthy();
  });

  it("says when there is no transcript, and why for a silent recording", () => {
    const pending = render(() => <CallRecordingCard event={recordingEvent({ content: null })} />);
    expect(pending.getByText("No transcript yet")).toBeTruthy();
    pending.unmount();
    const silent = render(() => (
      <CallRecordingCard
        event={recordingEvent({ content: null, type: "recording:unknown", people: "[]", title: "Unknown caller" }, { source: "whatsapp", recorded_sides: "silent" })}
      />
    ));
    expect(silent.container.textContent).toContain("WhatsApp call");
    expect(silent.getByText("No transcript: the recording is silent")).toBeTruthy();
    expect(silent.getByText("Unknown caller")).toBeTruthy();
  });

  it("names a recording placed by its call from the call's title, not its first person", () => {
    populateCache({ "phone:owner": { name: "Owner", username: null, contactId: 1, avatarUrl: null, isSelf: true } });
    const { getByText, queryByText } = render(() => (
      <CallRecordingCard
        event={recordingEvent(
          { type: "recording:unknown", title: "Alice", people: JSON.stringify(["phone:owner", "phone:+447700900123"]) },
          { source: "whatsapp", contact: "Ally" },
        )}
      />
    ));
    expect(getByText("Alice", { selector: "p" })).toBeTruthy();
    expect(queryByText("Owner")).toBeNull();
    expect(queryByText("Ally")).toBeNull();
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

  it("plays audio a browser can play, and says when there is none", () => {
    const playable = render(() => (
      <CallRecordingCard event={recordingEvent({}, { audio: { original: "/calls/Call_1.amr", flac: "/calls/Call_1.flac", levelled: null } })} />
    ));
    expect(playable.container.querySelector("audio")?.getAttribute("src")).toBe("/api/call-recordings/1/audio");
    playable.unmount();
    const amrOnly = render(() => (
      <CallRecordingCard event={recordingEvent({}, { audio: { original: "/calls/Call_1.amr", flac: null, levelled: null } })} />
    ));
    expect(amrOnly.container.querySelector("audio")).toBeNull();
    expect(amrOnly.getByText("No copy of the audio plays in a browser yet")).toBeTruthy();
  });
});

