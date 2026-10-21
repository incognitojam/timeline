import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import type { Attachment } from "../lib/api";
import AttachmentPreview from "./AttachmentPreview";

function makeAttachment(status: Attachment["status"]): Attachment {
  return {
    id: status === "pending" ? 1 : 2,
    event_id: 1,
    source: "example",
    source_id: null,
    filename: "example.bin",
    mime_type: "application/octet-stream",
    file_size: null,
    storage_path: null,
    status,
    width: null,
    height: null,
    thumbhash: null,
    description: null,
  };
}

describe("AttachmentPreview", () => {
  it("names pending and unavailable attachment states for assistive technology", () => {
    render(() => (
      <AttachmentPreview attachments={[makeAttachment("pending"), makeAttachment("failed")]} />
    ));

    expect(screen.getByRole("img", { name: "Attachment pending" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Attachment unavailable" })).toBeInTheDocument();
  });
});
