import { For, type JSX, Show } from "solid-js";
import type { ContentBlock } from "../../../lib/content-blocks";

export interface ChatSearchHit {
  url: string | null;
  updatedAt: string | null;
  title: string;
  preview: string;
}

export interface WebSearchHit {
  title: string;
  url: string | null;
  siteName: string | null;
  siteDomain: string | null;
  faviconUrl: string | null;
  text: string;
  isMissing: boolean;
}

// Returns a rich JSX rendering for known tools, or null when we should fall
// back to the generic pre-formatted text view.
export function tryRenderToolResult(
  toolName: string | undefined,
  result: ContentBlock
): JSX.Element | null {
  if (!toolName) return null;
  switch (toolName) {
    case "conversation_search": {
      const text = extractResultText(result);
      if (!text) return null;
      const hits = parseConversationSearchResults(text);
      if (hits.length === 0) return null;
      return <ConversationSearchView hits={hits} />;
    }
    case "web_search":
    case "web_fetch": {
      const hits = parseWebSearchResults(result);
      if (hits.length === 0) return null;
      return <WebSearchView hits={hits} />;
    }
    default:
      return null;
  }
}

function ConversationSearchView(props: { hits: ChatSearchHit[] }): JSX.Element {
  return (
    <ul class="space-y-1.5">
      <For each={props.hits}>
        {(hit) => (
          <li class="rounded border border-border/50 bg-background/60 px-2 py-1.5">
            <Show
              when={hit.url}
              fallback={<div class="font-medium text-sm">{hit.title}</div>}
            >
              {(url) => (
                <a
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-medium text-sm text-primary hover:underline block"
                >
                  {hit.title}
                </a>
              )}
            </Show>
            <div class="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
              <Show when={hit.updatedAt}>
                {(ts) => <span>{formatChatDate(ts())}</span>}
              </Show>
              <Show when={hit.preview}>
                <span class="truncate">{hit.preview}</span>
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

function WebSearchView(props: { hits: WebSearchHit[] }): JSX.Element {
  return (
    <ul class="space-y-1.5">
      <For each={props.hits}>
        {(hit) => (
          <li class="rounded border border-border/50 bg-background/60 px-2 py-1.5">
            <div class="flex items-start gap-2">
              <Show when={hit.faviconUrl}>
                {(src) => (
                  <img
                    src={src()}
                    alt=""
                    class="w-4 h-4 mt-0.5 shrink-0 rounded-sm"
                    loading="lazy"
                    onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
                  />
                )}
              </Show>
              <div class="min-w-0 flex-1">
                <Show
                  when={hit.url}
                  fallback={<div class="font-medium text-sm">{hit.title}</div>}
                >
                  {(url) => (
                    <a
                      href={url()}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="font-medium text-sm text-primary hover:underline block truncate"
                    >
                      {hit.title}
                    </a>
                  )}
                </Show>
                <Show when={hit.siteName ?? hit.siteDomain}>
                  {(site) => (
                    <div class="text-xs text-muted-foreground truncate">
                      {site()}
                    </div>
                  )}
                </Show>
                <Show when={hit.text}>
                  <div class="text-sm text-muted-foreground mt-0.5 line-clamp-3">
                    {hit.text}
                  </div>
                </Show>
              </div>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

export function extractResultText(result: ContentBlock): string | null {
  const content = result.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const obj = item as { type?: unknown; text?: unknown };
      if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
    } else if (typeof item === "string") {
      parts.push(item);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export function parseConversationSearchResults(text: string): ChatSearchHit[] {
  const hits: ChatSearchHit[] = [];
  const re = /<chat\s+([^>]+)>([\s\S]*?)<\/chat>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const attrs = parseAttrs(match[1]);
    // Strip the inner <chat_conversation>…</chat_conversation> wrapper if
    // present; what remains before it is the human-readable title line.
    const body = match[2]
      .replace(/<chat_conversation>[\s\S]*?<\/chat_conversation>/g, "")
      .trim();
    const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
    const title = firstLine.trim() || attrs.url || "Conversation";
    const rest = body.replace(firstLine, "").trim();
    hits.push({
      url: attrs.url ?? null,
      updatedAt: attrs.updated_at ?? null,
      title,
      preview: rest.slice(0, 200).replace(/\s+/g, " ").trim(),
    });
  }
  return hits;
}

export function parseWebSearchResults(result: ContentBlock): WebSearchHit[] {
  const content = result.content;
  if (!Array.isArray(content)) return [];
  const hits: WebSearchHit[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const obj = item as {
      type?: unknown;
      title?: unknown;
      url?: unknown;
      text?: unknown;
      is_missing?: unknown;
      metadata?: unknown;
    };
    if (obj.type !== "knowledge") continue;
    const md =
      obj.metadata && typeof obj.metadata === "object"
        ? (obj.metadata as Record<string, unknown>)
        : {};
    hits.push({
      title: typeof obj.title === "string" ? obj.title : "Untitled",
      url: typeof obj.url === "string" ? obj.url : null,
      siteName: typeof md.site_name === "string" ? md.site_name : null,
      siteDomain: typeof md.site_domain === "string" ? md.site_domain : null,
      faviconUrl: typeof md.favicon_url === "string" ? md.favicon_url : null,
      text: typeof obj.text === "string" ? obj.text : "",
      isMissing: obj.is_missing === true,
    });
  }
  return hits;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function formatChatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
