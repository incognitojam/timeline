// Mirror of `ContentBlock` from `src/parsers/shared/format-content.ts`.
// Kept in sync by convention; the parsers and the web app are in the same
// repo so divergence is caught in review.

export interface ContentBlock {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "flag"
    | "image"
    | "summary"
    // Block whose type wasn't recognized (parser writes `{type:"unknown",raw}`).
    // Preserved rather than dropped so block indices stay aligned with the raw
    // content array — attachment source_id paths are raw-array indices.
    | "unknown";
  text?: string;
  thinking?: string;
  summaries?: ThinkingSummary[];
  citations?: Citation[];
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  message?: string;
  integration_name?: string;
  integration_icon_url?: string;
  tool_use_id?: string;
  content?: unknown;
  error?: string;
  flag?: string;
  helpline?: Helpline | Helpline[];
  // image: MIME type of an inline image. Base64 bytes are not mirrored.
  media_type?: string;
  // summary: kind of compaction summary (Amp: "message" | "thread")
  summary_type?: string;
  // summary: referenced thread id for thread-level summaries (Amp)
  thread_id?: string;
  // unknown: the original block, kept for debugging. Never rendered.
  raw?: unknown;
}

export interface Citation {
  url?: string;
  title?: string;
  cited_text?: string;
  start_index?: number;
  end_index?: number;
}

export interface ThinkingSummary {
  summary?: string;
}

export interface Helpline {
  name?: string;
  phone_number?: string;
  sms_number?: string;
  web_chat_url?: string;
  url?: string;
}

export function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === "text" ||
    t === "thinking" ||
    t === "tool_use" ||
    t === "tool_result" ||
    t === "flag" ||
    t === "image" ||
    t === "summary" ||
    t === "unknown"
  );
}
