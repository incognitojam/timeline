import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { KeyedRecord } from "../../lib/createKeyedRecords";
import type { TimelineEvent } from "../../lib/types";
import { SubAgentGroup, type SubagentGroup } from "./SubAgentGroup";

vi.mock("../../lib/identities", () => {
  const senderFor = (event: { people: string | null }) => {
    if (!event.people) return null;
    const people = JSON.parse(event.people) as string[];
    return people[0] ?? null;
  };
  return {
    getSenderFromEvent: senderFor,
    getSenderIdentifier: senderFor,
  };
});

vi.mock("../AttachmentPreview", () => ({
  default: () => null,
}));

vi.mock("./AIMessageContent", () => ({
  AIMessageContent: () => null,
}));

function makeEvent(id: number, sender: string): TimelineEvent {
  return {
    id,
    source: "claude-code",
    source_id: `session-1:${id}`,
    source_account: "tester",
    type: "claude-code:message:assistant",
    timestamp: `2026-07-13T12:${String(id).padStart(2, "0")}:00.000Z`,
    end_timestamp: null,
    duration_ms: null,
    title: "project",
    content: `message ${id}`,
    latitude: null,
    longitude: null,
    location_name: null,
    people: JSON.stringify([sender]),
    tags: null,
    raw_data: JSON.stringify({ content: [{ type: "text", text: `message ${id}` }] }),
    imported_at: "2026-07-13T12:00:00.000Z",
    import_batch: null,
    conversation_id: null,
  };
}

function makeGroup(parentToolUseId: string, events: TimelineEvent[]): SubagentGroup {
  return {
    parentToolUseId,
    events,
    subagentType: "test",
    parentEventId: null,
  };
}

function makeRecord(group: SubagentGroup): KeyedRecord<string, SubagentGroup> {
  return {
    key: group.parentToolUseId,
    value: () => group,
  };
}

function renderAtNestingCap(
  group: SubagentGroup,
  nestedGroupRecordsFor: (eventId: number) => KeyedRecord<string, SubagentGroup>[],
  highlightEventId: () => number | undefined = () => undefined,
) {
  return render(() => (
    <SubAgentGroup
      group={group}
      resolveToolResult={() => undefined}
      defaultExpandedFor={() => true}
      highlightEventId={highlightEventId}
      nestedGroupRecordsFor={nestedGroupRecordsFor}
      conversationSource="claude-code"
      conversationTitle="project"
      attachmentsForEvent={() => []}
      depth={Number.MAX_SAFE_INTEGER}
    />
  ));
}

describe("SubAgentGroup", () => {
  it("keeps the target ring inside the highlighted row", () => {
    const event = makeEvent(1, "Alice");
    const view = renderAtNestingCap(
      makeGroup("root", [event]),
      () => [],
      () => event.id,
    );

    expect(view.container.querySelector("#event-1")).toHaveClass("ring-inset");
    view.unmount();
  });

  it("traverses capped descendants once", () => {
    const rootEvent = makeEvent(1, "Root");
    const deepEvents = Array.from({ length: 8 }, (_, index) =>
      makeEvent(index + 2, index < 4 ? "Alice" : "Bob"),
    );
    const records = deepEvents.map((event, index) =>
      makeRecord(makeGroup(`nested-${index}`, [event])),
    );
    const recordsByParentEvent = new Map<number, KeyedRecord<string, SubagentGroup>[]>();
    recordsByParentEvent.set(rootEvent.id, [records[0]]);
    for (let index = 0; index < deepEvents.length; index++) {
      const nextRecord = records[index + 1];
      recordsByParentEvent.set(deepEvents[index].id, nextRecord ? [nextRecord] : []);
    }
    const nestedGroupRecordsFor = vi.fn(
      (eventId: number) => recordsByParentEvent.get(eventId) ?? [],
    );

    const view = renderAtNestingCap(
      makeGroup("root", [rootEvent]),
      nestedGroupRecordsFor,
    );

    expect(view.container).toHaveTextContent(
      "Nesting depth exceeded — showing 8 deeper sub-agent messages flat",
    );
    const descendantTraversals = nestedGroupRecordsFor.mock.calls
      .map(([eventId]) => eventId)
      .filter((eventId) => eventId !== rootEvent.id);
    expect(descendantTraversals).toEqual(deepEvents.map((event) => event.id));
    view.unmount();
  });

  it("updates sender headers when a retained row gets a same-sender predecessor", () => {
    const rootEvent = makeEvent(1, "Root");
    const aliceEvent = makeEvent(2, "Alice");
    const retainedBobEvent = makeEvent(3, "Bob");
    const insertedBobEvent = makeEvent(4, "Bob");
    const [nestedGroup, setNestedGroup] = createSignal(
      makeGroup("nested", [aliceEvent, retainedBobEvent]),
    );
    const nestedRecord: KeyedRecord<string, SubagentGroup> = {
      key: "nested",
      value: nestedGroup,
    };
    const nestedGroupRecordsFor = (eventId: number) =>
      eventId === rootEvent.id ? [nestedRecord] : [];

    const view = renderAtNestingCap(
      makeGroup("root", [rootEvent]),
      nestedGroupRecordsFor,
    );
    const retainedRow = view.container.querySelector("#event-3");
    if (!retainedRow) throw new Error("Expected retained sub-agent row");
    expect(retainedRow).toHaveTextContent("Bob");

    setNestedGroup(makeGroup("nested", [aliceEvent, insertedBobEvent, retainedBobEvent]));

    const updatedRetainedRow = view.container.querySelector("#event-3");
    const insertedRow = view.container.querySelector("#event-4");
    expect(updatedRetainedRow).toBe(retainedRow);
    expect(updatedRetainedRow).not.toHaveTextContent("Bob");
    expect(insertedRow).toHaveTextContent("Bob");
    view.unmount();
  });
});
