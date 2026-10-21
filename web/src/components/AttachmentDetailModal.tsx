import { A } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import { createEffect, createResource, createSignal, For, type JSX, on, Show, Suspense } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { AttachmentDescriptionEntry, AttachmentDetail, AttachmentListItem } from "../lib/api";
import { createLocalStorageSignal } from "../lib/createLocalStorageSignal";
import { formatFileSize, formatPreciseDuration, getFileIcon } from "../lib/format";
import { fetchModels, groupModelsByProvider } from "../lib/llmModels";
import { useAttachmentDetail, useDescribeAttachment } from "../lib/queries";
import { buildEventUrl } from "../lib/routes";
import { getThumbhashUrl } from "../lib/thumbhash";
import Dialog from "../ui/Dialog";
import { IconAutoAwesome, IconOpenInNew, IconProgress, IconRefresh } from "../ui/icons";

interface Props {
  attachment: AttachmentListItem | null;
  onClose: () => void;
}

function mediaSrc(detail: AttachmentDetail): string {
  return `/api/media/${detail.storagePath}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Image preview with thumbhash placeholder and graceful load-failure state. */
function ImagePreview(props: { detail: AttachmentDetail }) {
  const [loaded, setLoaded] = createSignal(false);
  const [errored, setErrored] = createSignal(false);
  const thumbhashUrl = () => getThumbhashUrl(props.detail);

  return (
    <Show
      when={!errored()}
      fallback={
        <div class="flex h-40 items-center justify-center rounded-md bg-muted text-sm text-muted-foreground">
          Preview unavailable
        </div>
      }
    >
      <div class="relative overflow-hidden rounded-md bg-muted">
        <Show when={thumbhashUrl()}>
          {(url) => (
            <img
              src={url()}
              alt=""
              aria-hidden="true"
              class={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${loaded() ? "opacity-0" : "opacity-100"}`}
            />
          )}
        </Show>
        <img
          src={mediaSrc(props.detail)}
          alt={props.detail.filename || "Attachment"}
          class={`mx-auto max-h-[50vh] w-auto max-w-full object-contain transition-opacity duration-300 ${thumbhashUrl() ? (loaded() ? "opacity-100" : "opacity-0") : ""}`}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      </div>
    </Show>
  );
}

/** Media preview switch: image / video / audio / other. */
function MediaPreview(props: { detail: AttachmentDetail }) {
  const mime = () => props.detail.mimeType ?? "";
  return (
    <Show
      when={props.detail.storagePath}
      fallback={
        <div class="flex items-center gap-3 rounded-md bg-muted p-4 text-sm text-muted-foreground">
          <Dynamic
            component={getFileIcon(props.detail.filename, props.detail.mimeType)}
            class="h-6 w-6 shrink-0"
            aria-hidden
          />
          <span>Media file not available ({props.detail.status})</span>
        </div>
      }
    >
      <Show
        when={mime().startsWith("image/")}
        fallback={
          <Show
            when={mime().startsWith("video/")}
            fallback={
              <Show
                when={mime().startsWith("audio/")}
                fallback={
                  <a
                    href={mediaSrc(props.detail)}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="flex items-center gap-3 rounded-md border border-border bg-muted/50 p-4 text-sm hover:bg-muted"
                  >
                    <Dynamic
                      component={getFileIcon(props.detail.filename, props.detail.mimeType)}
                      class="h-6 w-6 shrink-0"
                      aria-hidden
                    />
                    <span class="truncate font-medium">
                      {props.detail.filename || "Open file"}
                    </span>
                  </a>
                }
              >
                <audio src={mediaSrc(props.detail)} controls preload="metadata" class="w-full" />
              </Show>
            }
          >
            <video
              src={mediaSrc(props.detail)}
              controls
              preload="metadata"
              class="max-h-[50vh] w-full rounded-md bg-black object-contain"
            />
          </Show>
        }
      >
        <ImagePreview detail={props.detail} />
      </Show>
    </Show>
  );
}

function MetaRow(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex justify-between gap-4 py-1.5 text-sm">
      <span class="shrink-0 text-muted-foreground">{props.label}</span>
      <span class="min-w-0 truncate text-right text-foreground">{props.children}</span>
    </div>
  );
}

function DescriptionEntry(props: {
  entry: AttachmentDescriptionEntry;
  onRegenerate: (model: string) => void;
  regenerating: boolean;
  disabled: boolean;
}) {
  return (
    <li class="rounded-md border border-border bg-card p-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="truncate font-mono text-xs text-foreground">{props.entry.model}</span>
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-50"
          disabled={props.disabled}
          onClick={() => props.onRegenerate(props.entry.model)}
        >
          <Show
            when={props.regenerating}
            fallback={<IconRefresh class="h-3.5 w-3.5" />}
          >
            <IconProgress class="h-3.5 w-3.5 animate-spin" />
          </Show>
          Regenerate
        </button>
      </div>
      <p class="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {props.entry.description}
      </p>
      <div class="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{formatTimestamp(props.entry.createdAt)}</span>
        <Show when={props.entry.durationMs !== null}>
          <span aria-hidden="true">·</span>
          <span>{formatPreciseDuration(props.entry.durationMs ?? 0)}</span>
        </Show>
      </div>
    </li>
  );
}

export default function AttachmentDetailModal(props: Props) {
  const previewDetail = (): AttachmentDetail | null => {
    const attachment = props.attachment;
    return attachment ? { ...attachment, descriptions: [] } : null;
  };
  const detailQuery = useAttachmentDetail(
    () => props.attachment?.id,
    () => props.attachment !== null,
    () => props.attachment ?? undefined,
  );
  const detail = () => detailQuery.data ?? previewDetail();

  const describeMutation = useDescribeAttachment(() => props.attachment?.id);

  // Clear any transient generate error/pending state when the target attachment
  // changes or the modal reopens, so a fresh open never shows stale results.
  createEffect(
    on(
      () => props.attachment?.id,
      () => describeMutation.reset(),
    ),
  );

  // Only fetch the model catalogue while the modal is open. A plain thunk (not a
  // memo) keeps the read lazy so it never pins the parent Suspense boundary.
  const [models] = createResource(
    () => (props.attachment !== null ? "open" : false),
    fetchModels,
  );
  const modelGroups = () => groupModelsByProvider(models() ?? []);
  const [preferredModel, setPreferredModel] = createLocalStorageSignal<string | null>(
    "timeline:attachment-describe-model",
    null,
  );
  const selectedModel = () => {
    const list = models();
    if (!list || list.length === 0) return null;
    const pref = preferredModel();
    if (pref && list.some((m) => m.id === pref)) return pref;
    return list[0].id;
  };

  const describable = () => {
    const d = detail();
    return Boolean(
      d && d.mimeType?.startsWith("image/") && d.contentHash && d.status === "stored",
    );
  };

  const pendingModel = () =>
    describeMutation.isPending ? (describeMutation.variables?.model ?? null) : null;

  const generate = (model: string | null) => {
    if (!model) return;
    describeMutation.mutate({ model });
  };

  const title = () => detail()?.filename || "Attachment";

  return (
    <Dialog
      open={props.attachment !== null}
      onClose={props.onClose}
      title={title()}
      class="max-w-2xl"
    >
      <Show
        when={detail()}
        fallback={
          <Show
            when={detailQuery.isError}
            fallback={
              <div class="flex h-40 items-center justify-center text-sm text-muted-foreground">
                <IconProgress class="mr-2 h-5 w-5 animate-spin" />
                Loading…
              </div>
            }
          >
            <div class="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
              Failed to load attachment.
            </div>
          </Show>
        }
      >
        {(loaded) => (
          <div class="space-y-6">
            <MediaPreview detail={loaded()} />

            {/* Metadata */}
            <div class="divide-y divide-border rounded-md border border-border px-3">
              <MetaRow label="Filename">{loaded().filename || "—"}</MetaRow>
              <MetaRow label="Type">{loaded().mimeType || "—"}</MetaRow>
              <Show when={loaded().width !== null && loaded().height !== null}>
                <MetaRow label="Dimensions">
                  {loaded().width} × {loaded().height}
                </MetaRow>
              </Show>
              <Show when={loaded().fileSize !== null}>
                <MetaRow label="Size">{formatFileSize(loaded().fileSize ?? 0)}</MetaRow>
              </Show>
              <MetaRow label="Source">{sourceLabel(loaded().source)}</MetaRow>
              <MetaRow label="Timestamp">{formatTimestamp(loaded().timestamp)}</MetaRow>
              <MetaRow label="Event">
                <A
                  href={buildEventUrl(loaded().eventId)}
                  class="inline-flex items-center gap-1 text-primary hover:underline"
                  onClick={props.onClose}
                >
                  #{loaded().eventId}
                  <IconOpenInNew class="h-3.5 w-3.5" />
                </A>
              </MetaRow>
            </div>

            {/* Generate section */}
            <Show when={describable()}>
              <div class="rounded-md border border-border bg-muted/30 p-3">
                <div class="mb-2 flex items-center gap-2 text-sm font-medium">
                  <IconAutoAwesome class="h-4 w-4 text-primary" />
                  Generate description
                </div>
                <Suspense
                  fallback={<p class="text-xs text-muted-foreground">Loading models…</p>}
                >
                  <Show
                    when={models() && (models()?.length ?? 0) > 0}
                    fallback={
                      <p class="text-xs text-muted-foreground">
                        No vision models are configured.
                      </p>
                    }
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <select
                        aria-label="Model"
                        class="min-w-0 flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        value={selectedModel() ?? ""}
                        onChange={(event) => setPreferredModel(event.currentTarget.value)}
                      >
                        <For each={modelGroups()}>
                          {(group) => (
                            <optgroup label={group.provider}>
                              <For each={group.models}>
                                {(model) => <option value={model.id}>{model.name}</option>}
                              </For>
                            </optgroup>
                          )}
                        </For>
                      </select>
                      <button
                        type="button"
                        class="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground enabled:hover:bg-primary/90 disabled:opacity-50"
                        disabled={describeMutation.isPending || !selectedModel()}
                        onClick={() => generate(selectedModel())}
                      >
                        <Show
                          when={describeMutation.isPending}
                          fallback={<IconAutoAwesome class="h-4 w-4" />}
                        >
                          <IconProgress class="h-4 w-4 animate-spin" />
                        </Show>
                        {describeMutation.isPending ? "Generating…" : "Generate"}
                      </button>
                    </div>
                  </Show>
                </Suspense>
                <Show when={describeMutation.isError}>
                  <p class="mt-2 text-xs text-red-400">
                    {describeMutation.error instanceof Error
                      ? describeMutation.error.message
                      : "Description generation failed."}
                  </p>
                </Show>
              </div>
            </Show>

            {/* Descriptions comparison list */}
            <div>
              <h3 class="mb-2 text-sm font-medium text-foreground">
                Descriptions
                <Show when={!detailQuery.isPlaceholderData && loaded().descriptions.length > 0}>
                  <span class="ml-1.5 font-normal text-muted-foreground">
                    ({loaded().descriptions.length})
                  </span>
                </Show>
              </h3>
              <Show
                when={!detailQuery.isPlaceholderData && !detailQuery.isError}
                fallback={
                  <Show
                    when={detailQuery.isError}
                    fallback={
                      <p class="flex items-center rounded-md bg-card p-4 text-sm text-muted-foreground">
                        <IconProgress class="mr-2 h-4 w-4 animate-spin" />
                        Loading descriptions…
                      </p>
                    }
                  >
                    <p class="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
                      Failed to load descriptions.
                    </p>
                  </Show>
                }
              >
                <Show
                  when={loaded().descriptions.length > 0}
                  fallback={
                    <p class="rounded-md bg-card p-4 text-sm text-muted-foreground">
                      No descriptions generated yet.
                    </p>
                  }
                >
                  <ul class="space-y-2">
                    <For each={loaded().descriptions}>
                      {(entry) => (
                        <DescriptionEntry
                          entry={entry}
                          onRegenerate={generate}
                          regenerating={pendingModel() === entry.model}
                          disabled={describeMutation.isPending}
                        />
                      )}
                    </For>
                  </ul>
                </Show>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
