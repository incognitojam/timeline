import { For, type JSX, Show } from "solid-js";
import { Markdown } from "../../Markdown";
import type { Citation } from "../../../lib/content-blocks";
import { rewriteClaudeCodeMarkup } from "./claude-code-markup";

export function TextBlock(props: {
  text: string;
  citations?: Citation[];
  asPlainText?: boolean;
}): JSX.Element {
  const cites = (): Citation[] =>
    (props.citations ?? []).filter((c) => c.url || c.title);

  const annotated = () => {
    const text = rewriteClaudeCodeMarkup(props.text);
    return spliceSuperscripts(text, cites());
  };

  return (
    <div>
      <Show
        when={!props.asPlainText}
        fallback={
          <p class="text-base whitespace-pre-wrap break-words">{annotated()}</p>
        }
      >
        <div class="prose dark:prose-invert max-w-none prose-p:my-1 prose-pre:my-1 prose-pre:text-sm prose-code:text-sm">
          <Markdown markdown={annotated()} />
        </div>
      </Show>
      <Show when={cites().length > 0}>
        <ol class="list-decimal pl-5 text-sm text-muted-foreground mt-1 space-y-0.5">
          <For each={cites()}>
            {(c) => (
              <li>
                <Show
                  when={c.url}
                  fallback={<span>{c.title ?? ""}</span>}
                >
                  {(url) => (
                    <a
                      href={url()}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-primary hover:underline"
                    >
                      {c.title ?? url()}
                    </a>
                  )}
                </Show>
                <Show when={c.cited_text}>
                  {(cited) => (
                    <span
                      class="block italic text-muted-foreground/80 truncate"
                      title={cited()}
                    >
                      “{truncate(cited(), 120)}”
                    </span>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}

const SUP_DIGITS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};

function toSuperscript(n: number): string {
  return String(n)
    .split("")
    .map((c) => SUP_DIGITS[c] ?? c)
    .join("");
}

function spliceSuperscripts(text: string, citations: Citation[]): string {
  type Entry = { index: number; n: number };
  const entries: Entry[] = [];
  citations.forEach((c, i) => {
    if (typeof c.end_index !== "number") return;
    if (!Number.isInteger(c.end_index)) return;
    if (c.end_index < 0 || c.end_index > text.length) return;
    if (
      typeof c.start_index === "number" &&
      c.start_index > c.end_index
    ) {
      return;
    }
    entries.push({ index: c.end_index, n: i + 1 });
  });
  if (entries.length === 0) return text;
  entries.sort((a, b) => b.index - a.index);
  let out = text;
  for (const { index, n } of entries) {
    out = `${out.slice(0, index)}${toSuperscript(n)}${out.slice(index)}`;
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
