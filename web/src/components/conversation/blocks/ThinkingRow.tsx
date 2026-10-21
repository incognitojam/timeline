import { createSignal, For, type JSX, Show } from "solid-js";
import type { ContentBlock, ThinkingSummary } from "../../../lib/content-blocks";
import { IconChevronRight, IconSchedule } from "../../../ui/icons";

// Flat single-line rendering of a thinking block. Mirrors ToolUseRow so the
// two interleave cleanly in a flat block flow. Click toggles between a
// truncated single-line preview and the full inline content — the same row
// grows in place rather than spawning a separate paragraph below.
export function ThinkingRow(props: { block: ContentBlock }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);

  const summaries = (): string[] => {
    const raw = (props.block.summaries ?? []) as ThinkingSummary[] | string[];
    const out: string[] = [];
    for (const s of raw) {
      const text = typeof s === "string" ? s : s?.summary;
      if (typeof text === "string" && text.length > 0) out.push(text);
    }
    return out;
  };

  const thinking = () => props.block.thinking ?? "";
  const hasTrace = () => thinking().length > 0;
  const hasSummaries = () => summaries().length > 0;
  const hasBody = () => hasTrace() || hasSummaries();

  // Collapsed preview is a single truncated line — flatten the whole thinking
  // trace into one space-joined string (or fall back to the last summary)
  // so the row shows as much context as fits before the ellipsis kicks in.
  const preview = () => {
    const list = summaries();
    const raw = list.length > 0 ? list[list.length - 1] : thinking();
    return raw.replace(/\s+/g, " ").trim();
  };

  return (
    <button
      type="button"
      class={`group flex items-start gap-2 text-left w-full px-1.5 py-0.5 rounded text-sm transition-colors ${
        hasBody() ? "cursor-pointer hover:bg-muted/50" : "cursor-default"
      } ${expanded() ? "bg-muted/40" : ""}`}
      onClick={() => hasBody() && setExpanded(!expanded())}
      disabled={!hasBody()}
    >
      <span class="mt-px shrink-0">
        <ThinkingIcon />
      </span>
      <div class="text-muted-foreground/80 italic min-w-0 flex-1">
        <Show
          when={expanded() && hasBody()}
          fallback={
            <span class="truncate block">
              {hasBody() ? preview() : "Thinking (no summary)"}
            </span>
          }
        >
          <Show when={hasSummaries()}>
            <ul class="list-disc pl-4 space-y-0.5 not-italic">
              <For each={summaries()}>{(s) => <li>{s}</li>}</For>
            </ul>
          </Show>
          <Show when={hasTrace()}>
            <pre
              class={`whitespace-pre-wrap break-words font-sans not-italic ${
                hasSummaries() ? "mt-2" : ""
              }`}
            >
              {thinking()}
            </pre>
          </Show>
        </Show>
      </div>
      <Show when={hasBody()}>
        <span class="mt-px shrink-0">
          <Chevron expanded={expanded()} />
        </span>
      </Show>
    </button>
  );
}

function ThinkingIcon(): JSX.Element {
  return <IconSchedule class="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />;
}

function Chevron(props: { expanded: boolean }): JSX.Element {
  return (
    <IconChevronRight
      class={`w-3 h-3 text-muted-foreground transition-opacity ${
        props.expanded ? "opacity-100 rotate-90" : "opacity-0 group-hover:opacity-60"
      }`}
      aria-hidden="true"
    />
  );
}
