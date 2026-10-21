import { type ConversationRangeExportFormat, DEFAULT_CONVERSATION_RANGE_EXPORT_FORMAT } from "@shared/conversation-export";
import { useQueryClient } from "@tanstack/solid-query";
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import type { ConversationRangeExportRequest, ConversationRangeExportResponse } from "../../lib/api";
import { queryOptions, useConversationRangeExport } from "../../lib/queries";
import { IconClose, IconCopy, IconDownload } from "../../ui/icons";
import SegmentedControl, { SegmentedToggle, SegmentedToggleGroup } from "../../ui/SegmentedControl";

export function ExportSelectionIcon(props: { class?: string }) {
  return <IconCopy class={props.class ?? "h-4 w-4"} aria-hidden="true" />;
}

function XIcon(props: { class?: string }) {
  return <IconClose class={props.class ?? "h-4 w-4"} aria-hidden="true" />;
}

function DownloadIcon(props: { class?: string }) {
  return <IconDownload class={props.class ?? "h-4 w-4"} aria-hidden="true" />;
}

function previewLineCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\r?\n/).length : 0;
}

function slugifyFilenamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildRangeExportFilename(range: ConversationRangeExportResponse["range"]): string {
  const parts = [slugifyFilenamePart(range.source)];
  const titleSlug = range.title ? slugifyFilenamePart(range.title) : "";
  if (titleSlug) parts.push(titleSlug);
  const startDate = range.startTimestamp?.slice(0, 10);
  const endDate = range.endTimestamp?.slice(0, 10);
  if (startDate) {
    parts.push(endDate && endDate !== startDate ? `${startDate}-to-${endDate}` : startDate);
  }
  const base = parts.filter(Boolean).join("-") || "conversation-export";
  return `${base}.txt`;
}

function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const RANGE_PREVIEW_TITLE_ID = "range-preview-title";

const TIMESTAMP_STYLE_OPTIONS = [
  { value: "date-headers", label: "Date headers" },
  { value: "full-timestamps", label: "Full timestamps" },
] as const satisfies readonly {
  value: ConversationRangeExportFormat["timestampStyle"];
  label: string;
}[];

interface ConversationRangeExportControlsProps {
  rangeMode: Accessor<boolean>;
  startEventId: Accessor<number | null>;
  endEventId: Accessor<number | null>;
  selectedLoadedCount: Accessor<number>;
  // First/last message ids of the whole conversation, or null until stats load.
  // Drives the "Select all" shortcut.
  conversationBounds: Accessor<{ startId: number; endId: number } | null>;
  sidebarOpen: Accessor<boolean>;
  onSelectRange: (startEventId: number, endEventId: number) => void;
  onClearSelection: () => void;
}

export function ConversationRangeExportControls(props: ConversationRangeExportControlsProps) {
  const queryClient = useQueryClient();
  const [previewOpen, setPreviewOpen] = createSignal(false);
  const [format, setFormat] = createSignal<ConversationRangeExportFormat>({
    ...DEFAULT_CONVERSATION_RANGE_EXPORT_FORMAT,
  });
  const [copyLoading, setCopyLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const rangeReady = () => props.startEventId() !== null && props.endEventId() !== null;

  const exportRequest = createMemo<ConversationRangeExportRequest | undefined>(() => {
    const startEventId = props.startEventId();
    const endEventId = props.endEventId();
    if (startEventId === null || endEventId === null) return undefined;
    return {
      startEventId,
      endEventId,
      format: format(),
    };
  });

  const previewRequest = createMemo(() => previewOpen() ? exportRequest() : undefined);
  const preview = useConversationRangeExport(previewRequest);

  const previewError = () => {
    const queryError = preview.error;
    if (!queryError) return null;
    return queryError instanceof Error ? queryError.message : String(queryError);
  };

  const previewResult = () => {
    if (previewError()) return undefined;
    // Reading query data while the first request is pending would trip the
    // route-level Suspense boundary. Status fields are always safe to inspect.
    if (!preview.isSuccess) return undefined;
    return preview.data;
  };

  const previewText = () => previewResult()?.text ?? "";

  const previewMetadata = () => {
    if (previewError()) {
      return "Preview failed";
    }
    const result = previewResult();
    if (!result) {
      return preview.isFetching ? "Loading..." : "No preview";
    }
    return `${result.eventCount.toLocaleString()} messages · ${previewLineCount(result.text).toLocaleString()} lines · ${result.tokenCount.toLocaleString()} tokens`;
  };

  const openPreview = () => {
    setError(null);
    setPreviewOpen(true);
  };

  // Select the whole conversation and jump straight to the preview, which shows
  // the true server-resolved message/token counts (the bottom bar's count only
  // reflects loaded messages, so it would understate a full-conversation span).
  const selectEntireConversation = () => {
    const bounds = props.conversationBounds();
    if (!bounds) return;
    props.onSelectRange(bounds.startId, bounds.endId);
    openPreview();
  };

  const closePreview = () => {
    setPreviewOpen(false);
    setError(null);
  };

  const updateFormat = (nextFormat: Partial<ConversationRangeExportFormat>) => {
    setError(null);
    setFormat((current) => ({
      ...current,
      ...nextFormat,
    }));
  };

  const runExport = async () => {
    const request = exportRequest();
    if (!request) return null;
    setCopyLoading(true);
    setError(null);
    try {
      const result = await queryClient.fetchQuery(queryOptions.conversationRangeExport(request));
      return result.text;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to export range");
      return null;
    } finally {
      setCopyLoading(false);
    }
  };

  const copyRangeExport = async () => {
    const text = await runExport();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      setError(error instanceof Error ? `Failed to copy range export: ${error.message}` : "Failed to copy range export");
    }
  };

  const copyPreviewExport = async () => {
    if (preview.isFetching || previewError()) return;
    const result = previewResult();
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.text);
    } catch (error) {
      setError(error instanceof Error ? `Failed to copy range export: ${error.message}` : "Failed to copy range export");
    }
  };

  const downloadPreviewExport = () => {
    if (preview.isFetching || previewError()) return;
    const result = previewResult();
    if (!result) return;
    try {
      downloadTextFile(buildRangeExportFilename(result.range), result.text);
    } catch (error) {
      setError(error instanceof Error ? `Failed to download range export: ${error.message}` : "Failed to download range export");
    }
  };

  createEffect(() => {
    if (props.rangeMode()) return;
    closePreview();
  });

  createEffect(on(
    () => [props.startEventId(), props.endEventId()],
    () => {
      setError(null);
    },
    { defer: true },
  ));

  createEffect(() => {
    if (!props.rangeMode()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (previewOpen()) {
        closePreview();
        return;
      }
      props.onClearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <>
      <Show when={props.rangeMode() && !previewOpen()}>
        <div class={`fixed inset-x-3 bottom-4 z-40 flex justify-center sm:inset-x-auto sm:bottom-6 sm:left-4 pointer-events-none ${props.sidebarOpen() ? "sm:right-72" : "sm:right-4"}`}>
          <div class="pointer-events-auto w-full max-w-2xl overflow-hidden rounded-lg bg-card shadow-lg">
            <div class="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
              <div class="flex min-w-0 flex-1 items-center gap-3">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <ExportSelectionIcon />
                </div>
                <div class="min-w-0">
                  <div class="text-sm font-semibold">Copy messages</div>
                  <div class="text-sm text-muted-foreground">
                    {props.startEventId() === null
                      ? "Click the first message"
                      : props.endEventId() === null
                        ? "Click the last message"
                        : `${props.selectedLoadedCount()} messages selected`}
                  </div>
                </div>
              </div>
              <div class="ml-auto flex items-center gap-2">
                <button
                  class="rounded-md border border-border bg-background/90 px-3 py-2 text-sm transition-colors enabled:hover:bg-accent disabled:opacity-50"
                  disabled={!props.conversationBounds()}
                  onClick={selectEntireConversation}
                  title="Select the entire conversation"
                >
                  Select all
                </button>
                <button
                  class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors enabled:hover:bg-primary/90 disabled:opacity-50"
                  disabled={!rangeReady() || copyLoading()}
                  onClick={copyRangeExport}
                >
                  <ExportSelectionIcon />
                  Copy
                </button>
                <button
                  class="rounded-md border border-border bg-background/90 px-3 py-2 text-sm transition-colors enabled:hover:bg-accent disabled:opacity-50"
                  disabled={!rangeReady() || copyLoading()}
                  onClick={openPreview}
                >
                  Preview
                </button>
                <button
                  class="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={props.onClearSelection}
                  title="Clear range selection"
                  aria-label="Clear range selection"
                >
                  <XIcon />
                </button>
              </div>
            </div>
            <Show when={error()}>
              {(message) => <div class="border-t border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-600 dark:text-red-400">{message()}</div>}
            </Show>
          </div>
        </div>
      </Show>
      <Show when={previewOpen()}>
        <RangeExportPreviewDialog
          format={format}
          loading={preview.isFetching}
          error={() => previewError() || error()}
          resultReady={() => Boolean(previewResult())}
          metadata={previewMetadata}
          text={previewError() ? "" : preview.isFetching && !previewResult() ? "Loading export..." : previewText()}
          onUpdateFormat={updateFormat}
          onCopy={copyPreviewExport}
          onDownload={downloadPreviewExport}
          onClose={closePreview}
        />
      </Show>
    </>
  );
}

interface RangeExportPreviewDialogProps {
  format: Accessor<ConversationRangeExportFormat>;
  loading: boolean;
  error: Accessor<string | null>;
  resultReady: Accessor<boolean>;
  metadata: Accessor<string>;
  text: string;
  onUpdateFormat: (format: Partial<ConversationRangeExportFormat>) => void;
  onCopy: () => void;
  onDownload: () => void;
  onClose: () => void;
}

function RangeExportPreviewDialog(props: RangeExportPreviewDialogProps) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-end justify-center bg-background/50 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={RANGE_PREVIEW_TITLE_ID}
    >
      <div class="flex h-[78vh] max-h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-card shadow-xl">
        <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <ExportSelectionIcon />
            </div>
            <div class="min-w-0">
              <div id={RANGE_PREVIEW_TITLE_ID} class="font-semibold">Export preview</div>
              <div class="text-sm text-muted-foreground">
                {props.metadata()}
              </div>
            </div>
          </div>
          <button
            class="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors enabled:hover:bg-primary/90 disabled:cursor-not-allowed"
            disabled={props.loading || Boolean(props.error()) || !props.resultReady()}
            onClick={props.onCopy}
          >
            <ExportSelectionIcon />
            Copy
          </button>
          <button
            class="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium transition-colors enabled:hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            disabled={props.loading || Boolean(props.error()) || !props.resultReady()}
            onClick={props.onDownload}
          >
            <DownloadIcon />
            Download
          </button>
          <button
            class="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close range preview"
            title="Close range preview"
            onClick={props.onClose}
          >
            <XIcon />
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-4 py-2">
          <SegmentedControl
            label="Timestamp style"
            options={TIMESTAMP_STYLE_OPTIONS}
            value={props.format().timestampStyle}
            onChange={(timestampStyle) => props.onUpdateFormat({ timestampStyle })}
          />
          <SegmentedToggleGroup label="Formatting options">
            <SegmentedToggle
              pressed={props.format().includeReactions}
              onChange={(includeReactions) => props.onUpdateFormat({ includeReactions })}
            >
              Reactions
            </SegmentedToggle>
            <SegmentedToggle
              pressed={props.format().compactAuthors}
              onChange={(compactAuthors) => props.onUpdateFormat({ compactAuthors })}
            >
              Group messages
            </SegmentedToggle>
            <SegmentedToggle
              pressed={props.format().anonymiseNames}
              title="Replace authors, reaction actors, and structured @mentions with Person 1, Person 2, and so on. Plain message text is unchanged."
              onChange={(anonymiseNames) => props.onUpdateFormat({ anonymiseNames })}
            >
              Anonymise names
            </SegmentedToggle>
          </SegmentedToggleGroup>
        </div>
        <Show when={props.error()}>
          {(message) => <div class="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-600 dark:text-red-400">{message()}</div>}
        </Show>
        <textarea
          class="min-h-0 flex-1 resize-none bg-background p-4 font-mono text-sm leading-relaxed outline-none"
          readonly
        >
          {props.text}
        </textarea>
      </div>
    </div>
  );
}
