import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { Attachment } from "../../lib/api";
import type { TimelineEvent } from "../../lib/types";
import { AIEventRow } from "./AIEventRow";

// Default content shape: a text block at index 0 and a top-level image block
// at index 1. Attachments address blocks by raw content-array index.
function makeEvent(
  content: unknown[] = [
    { type: "text", text: "look at this" },
    { type: "image", media_type: "image/png" },
  ]
): TimelineEvent {
  return {
    id: 42,
    source: "claude-code",
    source_id: "session-1:msg-image",
    source_account: "tester",
    type: "claude-code:message:user",
    timestamp: "2026-04-01T00:00:00.000Z",
    end_timestamp: null,
    duration_ms: null,
    title: "project",
    content: "",
    latitude: null,
    longitude: null,
    location_name: null,
    people: JSON.stringify(["claude-code:tester"]),
    tags: null,
    raw_data: JSON.stringify({ content }),
    imported_at: "2026-04-01T00:00:00.000Z",
    import_batch: null,
    conversation_id: "session-1",
  };
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 7,
    event_id: 42,
    source: "claude-code",
    source_id: "1",
    filename: "image-1.png",
    mime_type: "image/png",
    file_size: 12,
    storage_path: "claude-code/tester/session-1/msg-image/image-1.png",
    status: "stored",
    width: null,
    height: null,
    thumbhash: null,
    description: null,
    ...overrides,
  };
}

function renderRow(
  attachments: Attachment[],
  event: TimelineEvent = makeEvent(),
  isTargetEvent = false,
) {
  return render(() => (
    <AIEventRow
      event={event}
      showSenderHeader
      isTargetEvent={isTargetEvent}
      conversationSource="claude-code"
      conversationTitle="project"
      attachments={attachments}
      resolveToolResult={() => undefined}
      onPersonClick={() => undefined}
    />
  ));
}

describe("AIEventRow", () => {
  it("keeps the target ring inside the highlighted row", () => {
    const view = renderRow([], makeEvent(), true);

    expect(view.container.querySelector("#event-42")).toHaveClass("ring-inset");
  });

  it("renders a top-level stored image inline once, not in a trailing group", () => {
    const { getAllByAltText, queryByText } = renderRow([makeAttachment()]);

    // No metadata placeholder for the inlined block.
    expect(queryByText("Image (image/png)")).toBeNull();
    // Rendered exactly once (inline, not duplicated in the trailing group).
    expect(getAllByAltText("image-1.png")).toHaveLength(1);
  });

  it("keeps a nested (dotted source_id) attachment in the trailing group while a top-level one renders inline", () => {
    const nested = makeAttachment({
      id: 8,
      source_id: "0.content.1",
      filename: "nested.png",
      storage_path: "claude-code/tester/session-1/msg-image/nested.png",
    });
    const { getByAltText, queryByText } = renderRow([makeAttachment(), nested]);

    // Both render (top-level inline, nested in trailing group), placeholder gone
    // for the top-level image block.
    expect(queryByText("Image (image/png)")).toBeNull();
    expect(getByAltText("image-1.png")).toBeInTheDocument();
    expect(getByAltText("nested.png")).toBeInTheDocument();
  });

  it("inlines the image at its raw index when an unknown-type block precedes it", () => {
    // Regression: the parser writes source_id against the RAW content array,
    // where unrecognized block types keep their position. If the frontend
    // dropped them, every later index would shift and the attachment would
    // point at the wrong block.
    const event = makeEvent([
      { type: "future_block_type", payload: "??" },
      { type: "image", media_type: "image/png" },
    ]);
    const { getAllByAltText, queryByText } = renderRow([makeAttachment()], event);

    // Inline at the image block's position — no placeholder, no duplicate in
    // the trailing group.
    expect(queryByText("Image (image/png)")).toBeNull();
    const imgs = getAllByAltText("image-1.png");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toContain(
      "/api/media/claude-code/tester/session-1/msg-image/image-1.png"
    );
  });

  it("keeps the metadata placeholder when the image block has no matching attachment", () => {
    // A non-image attachment row exists, but nothing matches the image block's
    // index, so the placeholder must still show.
    const other = makeAttachment({
      id: 9,
      source_id: "5",
      filename: "notes.pdf",
      mime_type: "application/pdf",
      storage_path: "claude-code/tester/session-1/msg-image/notes.pdf",
    });
    const { getByText } = renderRow([other]);

    expect(getByText("Image (image/png)")).toBeInTheDocument();
  });

  it("shows a generated attachment description on hover", () => {
    const description = "A terminal window showing a completed test run.";
    const { getByTitle } = renderRow([makeAttachment({ description })]);

    expect(getByTitle(description)).toHaveAttribute("title", description);
  });
});
