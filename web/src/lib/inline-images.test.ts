import { describe, expect, it } from "vitest";
import type { Attachment } from "./api";
import type { ContentBlock } from "./content-blocks";
import { splitInlineImages } from "./inline-images";

function attachment(overrides: Partial<Attachment>): Attachment {
  return {
    id: 1,
    event_id: 1,
    source: "claude-code",
    source_id: "0",
    filename: "image.png",
    mime_type: "image/png",
    file_size: 10,
    storage_path: "claude-code/tester/s/m/image.png",
    status: "stored",
    width: null,
    height: null,
    thumbhash: null,
    description: null,
    ...overrides,
  };
}

const imageBlocks: ContentBlock[] = [
  { type: "text", text: "before" },
  { type: "image", media_type: "image/png" },
];

describe("splitInlineImages", () => {
  it("maps a top-level image attachment to its block index and removes it from trailing", () => {
    const a = attachment({ source_id: "1" });
    const { inline, trailing } = splitInlineImages(imageBlocks, [a]);
    expect(inline.get("1")).toBe(a);
    expect(trailing).toHaveLength(0);
  });

  it("resolves indices against the raw array, counting unknown blocks", () => {
    // parseAIContent preserves unrecognized entries as {type:"unknown"} so an
    // attachment's raw-array index still lands on the right block.
    const blocks: ContentBlock[] = [
      { type: "unknown", raw: { type: "future_block" } },
      { type: "image", media_type: "image/png" },
    ];
    const a = attachment({ source_id: "1" });
    const { inline, trailing } = splitInlineImages(blocks, [a]);
    expect(inline.get("1")).toBe(a);
    expect(trailing).toHaveLength(0);
  });

  it.each<{ name: string; blocks: ContentBlock[]; overrides: Partial<Attachment> }>([
    { name: "a nested source_id", blocks: imageBlocks, overrides: { source_id: "0.content.1" } },
    { name: "a non-image MIME type", blocks: [{ type: "image", media_type: "image/png" }], overrides: { source_id: "0", mime_type: "application/pdf" } },
    { name: "an attachment not stored", blocks: [{ type: "image", media_type: "image/png" }], overrides: { source_id: "0", status: "pending" } },
    { name: "a non-image block", blocks: [{ type: "text", text: "hi" }], overrides: { source_id: "0" } },
    { name: "a missing storage path", blocks: [{ type: "image", media_type: "image/png" }], overrides: { source_id: "0", storage_path: null } },
    { name: "a null source_id", blocks: imageBlocks, overrides: { source_id: null } },
  ])("keeps $name in trailing", ({ blocks, overrides }) => {
    const a = attachment(overrides);
    const { inline, trailing } = splitInlineImages(blocks, [a]);
    expect(inline.size).toBe(0);
    expect(trailing).toEqual([a]);
  });

  it("splits by identity when two rows share a source_id", () => {
    // Schema-anomaly case: only the row that actually won the map slot renders
    // inline; the other must not vanish — it stays in the trailing group.
    const blocks: ContentBlock[] = [{ type: "image", media_type: "image/png" }];
    const first = attachment({ id: 1, source_id: "0", filename: "first.png" });
    const second = attachment({ id: 2, source_id: "0", filename: "second.png" });
    const { inline, trailing } = splitInlineImages(blocks, [first, second]);
    expect(inline.get("0")).toBe(second);
    expect(trailing).toEqual([first]);
  });
});
