import { createMemo, createSignal, Show } from "solid-js";
import type { McpToolCall } from "../lib/api";
import { estimateTokens, formatAbsoluteTime, formatCallDuration } from "../lib/mcp-format";

function parseJsonBody(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatJsonBody(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export default function McpToolCallRow(props: { call: McpToolCall }) {
  const [expanded, setExpanded] = createSignal(false);
  const argsBody = createMemo(() => parseJsonBody(props.call.args_json));
  const argsText = createMemo(() => formatJsonBody(argsBody()));
  const resultText = () => props.call.result_text ?? "";
  const sizeLabel = () =>
    `${props.call.result_chars.toLocaleString()} chars · ${estimateTokens(props.call.result_chars)}`;
  const fullSize = () => Math.max(props.call.args_chars, props.call.result_chars);

  return (
    <>
      <tr class="border-b border-border last:border-0 hover:bg-muted/30">
        <td class="px-3 py-2 align-top">
          <button
            type="button"
            class="text-left font-mono text-sm text-foreground hover:underline underline-offset-2"
            onClick={() => setExpanded(!expanded())}
            aria-expanded={expanded()}
          >
            {props.call.tool_name}
          </button>
          <div class="text-xs text-muted-foreground mt-0.5">
            {formatAbsoluteTime(props.call.created_at)}
          </div>
        </td>
        <td class="px-3 py-2 align-top text-muted-foreground">
          {formatCallDuration(props.call.duration_ms)}
        </td>
        <td class="px-3 py-2 align-top text-muted-foreground">
          {sizeLabel()}
          <Show when={props.call.truncated === 1}>
            <div class="text-xs text-yellow-400">
              truncated (full size {fullSize().toLocaleString()} chars)
            </div>
          </Show>
        </td>
        <td class="px-3 py-2 align-top">
          <Show
            when={props.call.is_error === 1}
            fallback={<span class="text-xs text-green-400">OK</span>}
          >
            <span class="text-xs text-red-400">Error</span>
          </Show>
        </td>
      </tr>
      <Show when={expanded()}>
        <tr class="border-b border-border last:border-0 bg-muted/20">
          <td colSpan={4} class="px-3 py-3">
            <div class="grid gap-3 lg:grid-cols-2">
              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Args</div>
                <pre class="max-h-96 overflow-auto rounded-md border border-border bg-background p-3 text-xs whitespace-pre-wrap break-words">
                  {argsText()}
                </pre>
              </div>
              <div>
                <div class="text-xs font-medium text-muted-foreground mb-1">Result</div>
                <pre class="max-h-96 overflow-auto rounded-md border border-border bg-background p-3 text-xs whitespace-pre-wrap break-words">
                  {resultText()}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      </Show>
    </>
  );
}
