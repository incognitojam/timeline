import { z } from "zod";

/**
 * Shared content-block types for AI chat message parsers.
 * Used by: opencode, claude-code, amp, conductor.
 *
 * The structured blocks are preserved in `raw_data.content`. The `content`
 * column of the events table only stores the user-visible text (see
 * `extractText` below) — tool_use/tool_result/thinking blocks do not appear
 * there to keep FTS clean.
 */

const optionalString = z.preprocess(
  (value) => value === null ? undefined : value,
  z.string().optional()
);

const optionalNumber = z.preprocess(
  (value) => value === null ? undefined : value,
  z.number().optional()
);

function optionalArray<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) => value === null ? undefined : value,
    z.array(schema).optional()
  );
}

const optionalUnknown = z.preprocess(
  (value) => value === null ? undefined : value,
  z.unknown().optional()
);

const thinkingSummarySchema = z.object({
  summary: optionalString,
}).catchall(z.unknown());

const citationSchema = z.object({
  url: optionalString,
  title: optionalString,
  cited_text: optionalString,
  start_index: optionalNumber,
  end_index: optionalNumber,
}).catchall(z.unknown());

const helplineSchema = z.object({
  name: optionalString,
  phone_number: optionalString,
  sms_number: optionalString,
  web_chat_url: optionalString,
  url: optionalString,
}).catchall(z.unknown());

const optionalHelpline = z.preprocess(
  (value) => value === null ? undefined : value,
  z.union([helplineSchema, z.array(helplineSchema)]).optional()
);

export const contentBlockSchema = z.object({
  type: z.enum([
    "text",
    "thinking",
    "tool_use",
    "tool_result",
    "flag",
    "image",
    "summary",
  ]),
  text: optionalString,
  thinking: optionalString,
  // thinking: progressive 1-sentence milestones (Claude.ai)
  summaries: optionalArray(thinkingSummarySchema),
  // text: citation/attribution entries (Claude.ai)
  citations: optionalArray(citationSchema),
  // tool_use: name of the invoked tool
  name: optionalString,
  // tool_use: identifier used to link to the matching tool_result
  id: optionalString,
  // tool_use: parameters passed to the tool
  input: optionalUnknown,
  // tool_use: in-progress description shown while the tool runs (Claude.ai)
  message: optionalString,
  // tool_use: friendly integration label e.g. "Web Fetch" (Claude.ai)
  integration_name: optionalString,
  // tool_use: icon URL for the integration (Claude.ai)
  integration_icon_url: optionalString,
  // tool_result: the tool_use id this result belongs to
  tool_use_id: optionalString,
  // tool_result: output (string or array of blocks, depending on source)
  content: z.unknown().optional(),
  // tool_result: error message for failed tool runs (Amp uses this)
  error: optionalString,
  // flag: safety category (e.g. "self_harm_risk")
  flag: optionalString,
  // flag: country-specific support resources
  helpline: optionalHelpline,
  // image: MIME type of an inline image. The base64 bytes are not stored on
  // the normalized block.
  media_type: optionalString,
  // summary: kind of compaction summary (Amp: "message" | "thread")
  summary_type: optionalString,
  // summary: referenced thread id for thread-level summaries (Amp)
  thread_id: optionalString,
}).catchall(z.unknown());

const unknownContentBlockSchema = z.object({
  type: z.literal("unknown"),
  raw: z.unknown(),
}).catchall(z.unknown());

export type KnownContentBlock = z.infer<typeof contentBlockSchema>;
export type UnknownContentBlock = z.infer<typeof unknownContentBlockSchema>;
export type ContentBlock = KnownContentBlock | UnknownContentBlock;
export type Citation = z.infer<typeof citationSchema>;
export type ThinkingSummary = z.infer<typeof thinkingSummarySchema>;
export type Helpline = z.infer<typeof helplineSchema>;

/**
 * Extract user-visible text from a list of content blocks.
 *
 * `text` blocks and `summary` blocks (visible compaction summaries) contribute.
 * Thinking, tool_use, and tool_result blocks are available structured in
 * `raw_data.content` but are deliberately omitted from the `content` column so
 * FTS stays focused on what is shown in the conversation.
 */
export function extractText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { text: string } =>
      (b.type === "text" || b.type === "summary") &&
      typeof b.text === "string" &&
      b.text.length > 0
    )
    .map((b) => b.text)
    .join("\n\n");
}

/**
 * Normalize Anthropic-style content (string | ContentBlock[]) into a
 * ContentBlock[]. A bare string becomes a single text block.
 */
export function toContentBlocks(
  input: string | unknown[] | undefined | null
): ContentBlock[] {
  if (input == null) return [];
  if (typeof input === "string") {
    return input.length > 0 ? [{ type: "text", text: input }] : [];
  }
  if (Array.isArray(input)) {
    return input.map((block) => {
      const parsed = contentBlockSchema.safeParse(block);
      return parsed.success ? parsed.data : { type: "unknown", raw: block };
    });
  }
  return [];
}
