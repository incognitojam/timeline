import { createHash } from "node:crypto";

export const EVENT_LEAN_PROFILE = {
  name: "event-lean",
  version: 1,
  formatter: "event-lean",
} as const;

export interface EventForEmbedding {
  id: number;
  source: string;
  type: string;
  timestamp: string | null;
  end_timestamp?: string | null;
  title: string | null;
  content: string | null;
  location_name?: string | null;
}

/** The events columns an EventForEmbedding is read from. */
export const EVENT_FOR_EMBEDDING_COLUMNS = "id, source, type, timestamp, end_timestamp, title, content, location_name";

function verbalizeEventKind(source: string, type: string): string {
  const seenWords = new Set<string>();

  return [...source.split("-"), ...type.split(":")]
    .filter(segment => {
      const words = segment.toLowerCase().split(/[-\s]+/).filter(Boolean);
      if (words.length === 0 || words.every(word => seenWords.has(word))) return false;
      for (const word of words) seenWords.add(word);
      return true;
    })
    .join(" ");
}

/**
 * Byte budget for a rendered document. Tokenizers with byte fallback (Gemma's,
 * bge-m3's) never emit more tokens than the input has UTF-8 bytes, so a document
 * within this budget fits an 8K-token model window with room left for a
 * `document_prefix` and special tokens.
 */
export const MAX_RENDERED_BYTES = 8000;

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes, cut on a code point boundary. */
function truncateToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end).trimEnd();
}

/**
 * Render an event as kind, title, content, and location lines. When the
 * document would exceed MAX_RENDERED_BYTES, only the content is shortened, so
 * the kind, title, and location always reach the model.
 */
export function renderEventLean(event: EventForEmbedding): string {
  const title = event.title?.trim();
  const content = event.content?.trim();
  const shouldIncludeTitle = title && (!content || !content.startsWith(title));
  const render = (body: string | undefined) =>
    [verbalizeEventKind(event.source, event.type), shouldIncludeTitle ? title : null, body, event.location_name?.trim()]
      .filter((part): part is string => Boolean(part))
      .join("\n");

  const rendered = render(content);
  if (!content || Buffer.byteLength(rendered) <= MAX_RENDERED_BYTES) return rendered;

  const contentBudget = MAX_RENDERED_BYTES - (Buffer.byteLength(rendered) - Buffer.byteLength(content));
  if (contentBudget <= 0) throw new Error(`Event ${event.id} renders past ${MAX_RENDERED_BYTES} bytes without content`);
  return render(truncateToBytes(content, contentBudget));
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
