import type { Attachment } from "./api";
import type { ContentBlock } from "./content-blocks";

export interface InlineImageSplit {
  // Stored image attachments keyed by the content-array index (as a string)
  // of the top-level image block they came from. These render inline at the
  // block's position instead of in the trailing AttachmentPreview group.
  inline: ReadonlyMap<string, Attachment>;
  // Everything else, in original order: nested tool_result images, non-image
  // files, failed/pending stores, and rows whose source_id doesn't resolve to
  // a top-level image block.
  trailing: Attachment[];
}

// Split an event's stored attachments into inline images and the trailing
// group, so each pasted image can render at its original position in the
// message content.
//
// The link is the attachment's `source_id`, which encodes the block path set
// by the claude-code parser (see #522): a bare integer like "1" is the
// top-level content index, while a dotted path like "0.content.1" is nested
// inside a tool_result's content. The index is a position in the RAW content
// array — parseAIContent preserves unrecognized entries as `{type:"unknown"}`
// blocks so its indices stay aligned with that array.
export function splitInlineImages(
  blocks: ContentBlock[],
  attachments: readonly Attachment[]
): InlineImageSplit {
  const inline = new Map<string, Attachment>();
  for (const attachment of attachments) {
    if (attachment.status !== "stored") continue;
    if (!attachment.mime_type?.startsWith("image/")) continue;
    if (!attachment.storage_path) continue;
    const sourceId = attachment.source_id;
    if (!sourceId) continue;
    // Bare integer string only — dotted (nested) paths stay in the trailing group.
    if (!/^\d+$/.test(sourceId)) continue;
    if (blocks[Number(sourceId)]?.type !== "image") continue;
    inline.set(sourceId, attachment);
  }
  // Identity-based: if two rows ever shared a source_id, only the one actually
  // in the map renders inline — the other must stay visible in the trailing group.
  const trailing = attachments.filter(
    (a) => a.source_id === null || inline.get(a.source_id) !== a
  );
  return { inline, trailing };
}
