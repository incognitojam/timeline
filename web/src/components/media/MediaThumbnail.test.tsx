import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { type MediaThumbItem, MediaTile } from "./MediaThumbnail";

describe("MediaTile", () => {
  it("names a generic file link when its metadata has no text", () => {
    const item: MediaThumbItem = {
      thumbhash: null,
      mimeType: "application/octet-stream",
      filename: null,
      durationMs: null,
      description: null,
    };

    const view = render(() => <MediaTile item={item} src="/media/1" href="/attachments/1" />);

    expect(view.getByRole("link", { name: "Attachment" })).toBeInTheDocument();
  });
});
