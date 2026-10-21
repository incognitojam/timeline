import { createSignal, type JSX, Show } from "solid-js";
import type { ContentBlock } from "../../../lib/content-blocks";
import {
  IconBuild,
  IconChevronRight,
  IconDescription,
  IconEdit,
  IconPerson,
  IconSearch,
  IconTaskAlt,
  IconTerminal,
  IconTravelExplore,
} from "../../../ui/icons";
import { tryRenderToolResult } from "./tool-result-renderers";
import { primaryInputText, summarizeToolUse } from "./tool-summary";

// Flat single-line rendering of a tool_use block (with its paired
// tool_result). Designed to slot into a vertical flow alongside thinking
// rows and rendered text — no card chrome, just a row that expands in place
// when clicked.
export function ToolUseRow(props: {
  block: ContentBlock;
  result: ContentBlock | undefined;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const toolName = () => props.block.name ?? "unknown";

  const summary = () => summarizeToolUse(toolName(), props.block.input);
  const display = () =>
    summary()?.header ??
    primaryInputText(props.block.input) ??
    props.block.message ??
    toolName();
  const subtitle = () => summary()?.subtitle ?? null;

  const hasError = () => Boolean(props.result?.error);
  const rich = () => {
    const r = props.result;
    return r ? tryRenderToolResult(toolName(), r) : null;
  };
  const resultText = () => formatResultText(props.result);
  const hasDetail = () =>
    Boolean(props.block.input) ||
    rich() !== null ||
    resultText() !== null ||
    hasError();

  return (
    <div class="text-sm">
      <button
        type="button"
        class={`group flex items-center gap-2 text-left w-full px-1.5 py-0.5 rounded transition-colors ${
          hasDetail() ? "cursor-pointer hover:bg-muted/50" : "cursor-default"
        } ${expanded() ? "bg-muted/40" : ""}`}
        onClick={() => hasDetail() && setExpanded(!expanded())}
        disabled={!hasDetail()}
      >
        <ToolIcon block={props.block} />
        <span class="text-muted-foreground truncate min-w-0 flex-1">
          {display()}
        </span>
        <Show when={hasError()}>
          <span class="text-red-500 text-xs shrink-0">error</span>
        </Show>
        <Show when={hasDetail()}>
          <Chevron expanded={expanded()} />
        </Show>
      </button>
      <Show when={expanded() && hasDetail()}>
        <div class="px-2 pb-2 pt-1 space-y-1.5">
          <Show when={subtitle()}>
            {(s) => <p class="text-xs text-muted-foreground/80">{s()}</p>}
          </Show>
          <Show when={hasError()}>
            <pre class="whitespace-pre-wrap break-words text-sm text-red-900 dark:text-red-200">
              {props.result?.error}
            </pre>
          </Show>
          <Show
            when={rich()}
            fallback={
              <Show when={resultText()}>
                {(t) => (
                  <pre class="whitespace-pre-wrap break-words text-sm text-muted-foreground max-h-96 overflow-auto">
                    {t()}
                  </pre>
                )}
              </Show>
            }
          >
            {(r) => <div>{r()}</div>}
          </Show>
          <Show when={props.block.input}>
            {(input) => (
              <details class="text-xs text-muted-foreground/70">
                <summary class="cursor-pointer">input</summary>
                <pre class="whitespace-pre-wrap break-words mt-1">
                  {JSON.stringify(input(), null, 2)}
                </pre>
              </details>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

function Chevron(props: { expanded: boolean }): JSX.Element {
  return (
    <IconChevronRight
      class={`w-3 h-3 shrink-0 text-muted-foreground transition-opacity ${
        props.expanded ? "opacity-100 rotate-90" : "opacity-0 group-hover:opacity-60"
      }`}
      aria-hidden="true"
    />
  );
}

function ToolIcon(props: { block: ContentBlock }): JSX.Element {
  const url = () => props.block.integration_icon_url;
  const name = () => props.block.name ?? "";
  return (
    <Show when={url()} fallback={<BuiltInToolIcon name={name()} />}>
      {(src) => (
        <img
          src={src()}
          alt=""
          class="w-4 h-4 rounded-sm shrink-0"
          loading="lazy"
          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
        />
      )}
    </Show>
  );
}

function BuiltInToolIcon(props: { name: string }): JSX.Element {
  const className = "w-3.5 h-3.5 shrink-0 text-muted-foreground";
  switch (props.name) {
    case "web_search":
    case "web_fetch":
    case "WebSearch":
    case "WebFetch":
      return <IconTravelExplore class={className} aria-hidden="true" />;
    case "Bash":
      return <IconTerminal class={className} aria-hidden="true" />;
    case "Read":
    case "view":
      return <IconDescription class={className} aria-hidden="true" />;
    case "Edit":
    case "Write":
    case "str_replace":
      return <IconEdit class={className} aria-hidden="true" />;
    case "Grep":
    case "Glob":
      return <IconSearch class={className} aria-hidden="true" />;
    case "TodoWrite":
      return <IconTaskAlt class={className} aria-hidden="true" />;
    case "Task":
    case "Agent":
      return <IconPerson class={className} aria-hidden="true" />;
    default:
      return <IconBuild class={className} aria-hidden="true" />;
  }
}

function formatResultText(result: ContentBlock | undefined): string | null {
  if (!result) return null;
  const c = result.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const item of c) {
      if (item && typeof item === "object") {
        const obj = item as { type?: unknown; text?: unknown };
        if (obj.type === "text" && typeof obj.text === "string") {
          parts.push(obj.text);
          continue;
        }
      }
      if (typeof item === "string") parts.push(item);
      else parts.push(JSON.stringify(item, null, 2));
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (c === null || c === undefined) return null;
  return JSON.stringify(c, null, 2);
}
