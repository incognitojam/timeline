import { createSignal, createEffect, on, createResource, For, Show, onCleanup } from "solid-js";
import { Markdown } from "../Markdown";
import { createLocalStorageSignal } from "../../lib/createLocalStorageSignal";
import { formatPreciseDuration } from "../../lib/format";
import { fetchModels, groupModelsByProvider, formatContextLength } from "../../lib/llmModels";
import { IconClose } from "../../ui/icons";

interface SummaryMetadata {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
  generationMs: number;
  finishReason?: string;
}

interface SummaryMeta {
  tokenCount: number;
  eventCount: number;
  model: string;
  cached: boolean;
  metadata: SummaryMetadata | null;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCost(cost: number): string {
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  if (cost >= 0.001) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

/** Derive a short display name from a model ID (strip provider prefix and :free suffix) */
function modelDisplayName(id: string): string {
  const parts = id.split("/");
  const name = parts[parts.length - 1].replace(/:free$/, "");
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface Props {
  date: string;
  onClose: () => void;
}

export default function SummaryPane(props: Props) {
  const [models] = createResource(fetchModels);
  const [text, setText] = createSignal("");
  const [summaryMeta, setSummaryMeta] = createSignal<SummaryMeta | null>(null);
  const [summaryLoading, setSummaryLoading] = createSignal(false);
  const [summaryError, setSummaryError] = createSignal<string | null>(null);
  const [preferredModel, setPreferredModel] = createLocalStorageSignal<string | null>(
    "timeline:summary-model",
    null,
  );

  const selectedModel = () => {
    const m = models();
    if (!m || m.length === 0) return null;
    const pref = preferredModel();
    if (pref && m.some((opt) => opt.id === pref)) return pref;
    return m[0].id;
  };

  let abortController: AbortController | null = null;

  const fetchSummary = async (regenerate = false) => {
    const model = selectedModel();
    if (!model) return;

    // Cancel any in-flight request
    abortController?.abort();
    abortController = new AbortController();

    setSummaryLoading(true);
    setSummaryError(null);
    setText("");
    setSummaryMeta(null);

    try {
      const params = new URLSearchParams({ model });
      if (regenerate) params.set("regenerate", "true");

      const response = await fetch(
        `/api/day/${props.date}/summary?${params}`,
        { signal: abortController.signal }
      );

      if (!response.ok) {
        const errText = await response.text();
        setSummaryError(`Server error: ${response.status}${errText ? ` - ${errText}` : ""}`);
        return;
      }

      if (!response.body) {
        setSummaryError("No response body");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let metadataBuffer = "";
      let foundDelimiter = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        // Strip keepalive bytes (\x01)
        const cleaned = chunk.replace(/\x01/g, "");
        if (!cleaned) continue;

        if (foundDelimiter) {
          // Already past delimiter, accumulate metadata
          metadataBuffer += cleaned;
          continue;
        }

        const delimiterIndex = cleaned.indexOf("\0");
        if (delimiterIndex === -1) {
          // No delimiter yet — this is summary text
          setText(prev => prev + cleaned);
        } else {
          // Found delimiter — split text before/after
          const summaryPart = cleaned.slice(0, delimiterIndex);
          if (summaryPart) {
            setText(prev => prev + summaryPart);
          }
          metadataBuffer = cleaned.slice(delimiterIndex + 1);
          foundDelimiter = true;
        }
      }

      // Flush any remaining bytes from the decoder
      const remaining = decoder.decode();
      if (remaining) metadataBuffer += remaining;

      if (!metadataBuffer) {
        setSummaryError("Empty response from server - the request may have timed out");
        return;
      }

      const result = JSON.parse(metadataBuffer);
      if (result.error) {
        setSummaryError(result.details ? `${result.error}: ${result.details}` : result.error);
      } else {
        setSummaryMeta(result);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setSummaryError(e instanceof Error ? e.message : "Failed to generate summary");
    } finally {
      setSummaryLoading(false);
    }
  };

  // Auto-fetch on date or model change
  createEffect(on(
    () => [props.date, selectedModel()] as const,
    () => {
      if (!selectedModel()) return;
      setText("");
      setSummaryMeta(null);
      setSummaryError(null);
      fetchSummary();
    }
  ));

  onCleanup(() => {
    abortController?.abort();
  });

  const hasContent = () => text().length > 0 || summaryMeta() !== null;

  return (
    <div class="h-full flex flex-col">
      {/* Header */}
      <div class="shrink-0 px-3 py-2 border-b border-border bg-card">
        <div class="flex items-center justify-between">
          <h2 class="font-medium text-foreground text-sm">AI Summary</h2>
          <button
            onClick={props.onClose}
            class="text-muted-foreground hover:text-foreground p-1 -mr-1"
            title="Close summary"
          >
            <IconClose class="w-4 h-4" />
          </button>
        </div>

        {/* Model selector + regenerate */}
        <Show
          when={!models.loading && (models() ?? []).length > 0}
          fallback={
            <Show when={!models.loading}>
              <p class="text-xs text-muted-foreground mt-2">AI summaries unavailable</p>
            </Show>
          }
        >
          <div class="flex items-center gap-2 mt-2">
            <select
              class="flex-1 text-xs bg-background border border-border rounded px-2 py-1"
              value={selectedModel() ?? ""}
              onChange={(e) => setPreferredModel(e.target.value)}
              disabled={summaryLoading()}
            >
              <For each={groupModelsByProvider(models() ?? [])}>
                {(group) => (
                  <optgroup label={group.provider}>
                    <For each={group.models}>
                      {(opt) => (
                        <option value={opt.id}>
                          {opt.name} ({opt.price} · {formatContextLength(opt.contextLength)})
                        </option>
                      )}
                    </For>
                  </optgroup>
                )}
              </For>
            </select>
            <button
              onClick={() => fetchSummary(true)}
              disabled={summaryLoading() || !selectedModel()}
              class="text-xs text-muted-foreground enabled:hover:text-foreground px-2 py-1 rounded border border-border enabled:hover:bg-accent disabled:opacity-50 shrink-0"
              title="Regenerate summary"
            >
              Regenerate
            </button>
          </div>
        </Show>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-auto p-3">
        <Show when={summaryError()}>
          <p class="text-xs text-red-500 mb-2">{summaryError()}</p>
        </Show>

        <Show when={summaryLoading() && text().length === 0}>
          <div class="text-sm text-muted-foreground animate-pulse">Generating summary...</div>
        </Show>

        <Show when={hasContent()}>
          <div class="prose prose-sm dark:prose-invert max-w-none">
            <Markdown markdown={text()} />
          </div>

          {/* Generation metadata */}
          <Show when={summaryMeta()}>
            {(meta) => {
              const tokPerSec = () => {
                const m = meta().metadata;
                if (m && m.outputTokens > 0 && m.generationMs > 0) {
                  return (m.outputTokens / (m.generationMs / 1000)).toFixed(1);
                }
                return null;
              };

              return (
                <div class="mt-4 pt-3 border-t border-border">
                  <div class="text-xs text-muted-foreground space-y-1.5">
                    {/* Model name + cached badge */}
                    <div class="font-medium text-muted-foreground/80">
                      {models()?.find((m) => m.id === meta().model)?.name ?? modelDisplayName(meta().model)}
                      <Show when={meta().cached}>
                        <span class="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          cached
                        </span>
                      </Show>
                    </div>

                    {/* Generation time */}
                    <Show when={!meta().cached && meta().metadata}>
                      {(m) => (
                        <Show when={m().generationMs > 0}>
                          <div>
                            Generated in {formatPreciseDuration(m().generationMs)}
                            <Show when={tokPerSec()}>
                              {(tps) => <span class="ml-1 text-muted-foreground/60">({tps()} tok/s)</span>}
                            </Show>
                          </div>
                        </Show>
                      )}
                    </Show>

                    {/* Token stats table */}
                    <Show when={meta().metadata}>
                      {(m) => (
                        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
                          <Show when={m().inputTokens > 0}>
                            <span class="text-muted-foreground/60">Input</span>
                            <span class="text-right">{formatNumber(m().inputTokens)}</span>
                          </Show>
                          <Show when={m().outputTokens > 0}>
                            <span class="text-muted-foreground/60">Output</span>
                            <span class="text-right">{formatNumber(m().outputTokens)}</span>
                          </Show>
                          <Show when={(m().reasoningTokens ?? 0) > 0}>
                            <span class="text-muted-foreground/60">↳ reasoning</span>
                            <span class="text-right">{formatNumber(m().reasoningTokens ?? 0)}</span>
                          </Show>
                          <Show when={(m().cacheReadTokens ?? 0) > 0}>
                            <span class="text-muted-foreground/60">Cache read</span>
                            <span class="text-right">{formatNumber(m().cacheReadTokens ?? 0)}</span>
                          </Show>
                          <Show when={(m().cacheWriteTokens ?? 0) > 0}>
                            <span class="text-muted-foreground/60">Cache write</span>
                            <span class="text-right">{formatNumber(m().cacheWriteTokens ?? 0)}</span>
                          </Show>
                          <Show when={(m().cost ?? 0) > 0}>
                            <span class="text-muted-foreground/60">Cost</span>
                            <span class="text-right">{formatCost(m().cost ?? 0)}</span>
                          </Show>
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
              );
            }}
          </Show>
        </Show>

        <Show when={!summaryLoading() && !hasContent() && !summaryError()}>
          <div class="text-sm text-muted-foreground">No summary available</div>
        </Show>
      </div>
    </div>
  );
}
