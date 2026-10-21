import { createMemo, createSignal, For, Show } from "solid-js";
import type { AttachmentListItem, AttachmentsStats } from "../lib/api";
import { createKeyedRecords } from "../lib/createKeyedRecords";
import { useAttachments, useAttachmentsStats } from "../lib/queries";
import { ATTACHMENTS_PAGE_SIZE } from "../lib/query-params";
import { buildEventUrl } from "../lib/routes";
import SegmentedControl from "../ui/SegmentedControl";
import AttachmentDescriptionHistoryCard from "./AttachmentDescriptionHistoryCard";
import AttachmentDetailModal from "./AttachmentDetailModal";
import InfiniteScrollSentinel from "./media/InfiniteScrollSentinel";
import { type MediaThumbItem, MediaTile } from "./media/MediaThumbnail";
import { formatMonthKey, groupByMonth } from "./media/mediaGrouping";
import SourceFilterButton from "./timeline/SourceFilterButton";

type MimeFilter = "all" | "image" | "video" | "audio";
type DescribedFilter = "all" | "described" | "undescribed";

const MIME_OPTIONS = [
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
] as const satisfies readonly { value: MimeFilter; label: string }[];

const DESCRIBED_OPTIONS = [
  { value: "all", label: "All" },
  { value: "described", label: "Described" },
  { value: "undescribed", label: "Undescribed" },
] as const satisfies readonly { value: DescribedFilter; label: string }[];

/**
 * Gallery-local default. Recall captures every 30s, so its screenshots swamp
 * the grid; every other source starts visible. Kept separate from the day
 * timeline's persisted preference so hiding a source here is not sticky there.
 */
const DEFAULT_HIDDEN_SOURCES: readonly string[] = ["recall"];

/** Abnormal statuses surfaced prominently in the stats header. */
const ABNORMAL_STATUSES = [
  { key: "pending", label: "Pending", tone: "text-amber-500" },
  { key: "failed", label: "Failed", tone: "text-red-500" },
  { key: "unrecoverable", label: "Unrecoverable", tone: "text-red-500" },
] as const;

function fmt(n: number): string {
  return n.toLocaleString();
}

function toMediaItem(attachment: AttachmentListItem): MediaThumbItem {
  return {
    thumbhash: attachment.thumbhash,
    mimeType: attachment.mimeType,
    filename: attachment.filename,
    durationMs: attachment.durationMs,
    description: attachment.description,
  };
}

function Stat(props: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div class="flex flex-col">
      <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{props.label}</span>
      <span class={`font-mono text-lg leading-tight ${props.tone ?? "text-foreground"}`}>
        {props.value}
      </span>
      <Show when={props.hint}>
        <span class="text-[11px] text-muted-foreground">{props.hint}</span>
      </Show>
    </div>
  );
}

function StatsHeader(props: { stats: AttachmentsStats }) {
  const describedPct = () =>
    props.stats.descriptionEligibleHashes > 0
      ? Math.round((props.stats.describedHashes / props.stats.descriptionEligibleHashes) * 100)
      : 0;

  return (
    <div class="rounded-lg border border-border bg-card p-4">
      <div class="flex flex-wrap gap-x-8 gap-y-4">
        <Stat label="Total" value={fmt(props.stats.total)} />
        <Stat label="Stored" value={fmt(props.stats.byStatus.stored)} />
        <For each={ABNORMAL_STATUSES}>
          {(status) => (
            <Show when={props.stats.byStatus[status.key] > 0}>
              <Stat
                label={status.label}
                value={fmt(props.stats.byStatus[status.key])}
                tone={status.tone}
              />
            </Show>
          )}
        </For>
        <Stat label="Unique files" value={fmt(props.stats.distinctHashes)} />
        <Stat
          label="Described"
          value={`${fmt(props.stats.describedHashes)} / ${fmt(props.stats.descriptionEligibleHashes)}`}
          hint={`${describedPct()}% of eligible files`}
        />
        <Stat
          label="Needs description"
          value={fmt(props.stats.needingDescription)}
          tone={props.stats.needingDescription > 0 ? "text-amber-500" : "text-foreground"}
        />
      </div>

      <Show when={props.stats.byModel.length > 0}>
        <div class="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span class="text-[11px] uppercase tracking-wide text-muted-foreground">By model</span>
          <For each={props.stats.byModel}>
            {(model) => (
              <span class="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs">
                <span class="text-foreground">{model.model}</span>
                <span class="font-mono text-muted-foreground">{fmt(model.count)}</span>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export default function AttachmentsView() {
  const [mimeFilter, setMimeFilter] = createSignal<MimeFilter>("all");
  const [describedFilter, setDescribedFilter] = createSignal<DescribedFilter>("all");
  const [hiddenSources, setHiddenSources] = createSignal<ReadonlySet<string>>(
    new Set(DEFAULT_HIDDEN_SOURCES),
  );
  const [selectedAttachment, setSelectedAttachment] = createSignal<AttachmentListItem | null>(null);

  const toggleHiddenSource = (source: string) => {
    const next = new Set(hiddenSources());
    if (next.has(source)) next.delete(source);
    else next.add(source);
    setHiddenSources(next);
  };

  // Sorted so toggling sources in different orders produces the same query key.
  const excludeSources = createMemo(() => [...hiddenSources()].sort());

  // Plain activation, by mouse or keyboard, opens the in-app detail modal;
  // modifier and middle clicks follow the tile's href to the event page.
  const openDetail = (event: MouseEvent, attachment: AttachmentListItem) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setSelectedAttachment(attachment);
  };

  const statsQuery = useAttachmentsStats();
  const stats = () =>
    statsQuery.isPending || statsQuery.isLoadingError ? null : statsQuery.data;

  const attachmentsQuery = useAttachments(() => {
    const mime = mimeFilter();
    const described = describedFilter();
    return {
      limit: ATTACHMENTS_PAGE_SIZE,
      mime: mime === "all" ? undefined : mime,
      excludeSources: excludeSources(),
      described: described === "all" ? undefined : described === "described",
    };
  });

  const attachments = createMemo(() => {
    if (attachmentsQuery.isPending || attachmentsQuery.isLoadingError) return [];
    return attachmentsQuery.data?.pages.flatMap((page) => page.attachments) ?? [];
  });

  const observerVersion = () =>
    `${mimeFilter()}\0${describedFilter()}\0${excludeSources().join(",")}\0${attachmentsQuery.dataUpdatedAt}`;

  const monthGroupRecords = createKeyedRecords(
    () => Array.from(groupByMonth(attachments()), ([month, items]) => ({ month, items })),
    (group) => group.month,
  );

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-6xl mx-auto px-4 py-6">
        <h1 class="mb-6 font-display text-2xl font-medium">Attachments</h1>

        <Show when={stats()}>
          {(loaded) => (
            <div class="mb-6">
              <StatsHeader stats={loaded()} />
            </div>
          )}
        </Show>

        {/* Long-horizon description backlog; loads independently of the gallery */}
        <AttachmentDescriptionHistoryCard />

        {/* Filters */}
        <div class="mb-6 flex flex-wrap items-center gap-3">
          <SegmentedControl
            label="Media type"
            options={MIME_OPTIONS}
            value={mimeFilter()}
            onChange={setMimeFilter}
          />
          <SegmentedControl
            label="Description status"
            options={DESCRIBED_OPTIONS}
            value={describedFilter()}
            onChange={setDescribedFilter}
          />
          <SourceFilterButton
            bySource={stats()?.bySource}
            hiddenSources={hiddenSources()}
            onToggleSource={toggleHiddenSource}
            onClearSources={() => setHiddenSources(new Set<string>())}
            emptyMessage="No sources with attachments yet."
            align="left"
            compact
          />
        </div>

        {/* Loading state */}
        <Show when={attachmentsQuery.isPending}>
          <div class="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
            <For each={Array.from({ length: 12 })}>
              {() => <div class="aspect-square rounded-sm bg-accent animate-pulse" />}
            </For>
          </div>
        </Show>

        {/* Error state */}
        <Show when={attachmentsQuery.isError}>
          <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
            Failed to load attachments.
          </div>
        </Show>

        {/* Empty state */}
        <Show when={attachmentsQuery.isSuccess && attachments().length === 0}>
          <div class="rounded-lg bg-card p-6 text-center text-sm text-muted-foreground">
            No attachments match these filters.
          </div>
        </Show>

        {/* Gallery grouped by month */}
        <Show when={attachments().length > 0}>
          <For each={monthGroupRecords()}>
            {(record) => {
              const group = record.value;
              return (
                <div class="mb-4">
                  <h2 class="sticky top-0 z-10 -mx-4 bg-background px-4 py-1.5 text-xs font-medium text-muted-foreground">
                    {formatMonthKey(group().month)}
                  </h2>
                  <div class="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
                    <For each={group().items}>
                      {(attachment) => (
                        <MediaTile
                          item={toMediaItem(attachment)}
                          src={`/api/media/${attachment.storagePath}`}
                          href={buildEventUrl(attachment.eventId)}
                          onSelect={(event) => openDetail(event, attachment)}
                        />
                      )}
                    </For>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>

        {/* Infinite scroll sentinel */}
        <InfiniteScrollSentinel
          version={observerVersion()}
          hasNextPage={attachmentsQuery.hasNextPage}
          isFetchingNextPage={attachmentsQuery.isFetchingNextPage}
          onLoadMore={() => void attachmentsQuery.fetchNextPage()}
        />

        {/* Loading more indicator */}
        <Show when={attachmentsQuery.isFetchingNextPage}>
          <div class="flex justify-center py-3">
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </Show>
      </div>

      <AttachmentDetailModal
        attachment={selectedAttachment()}
        onClose={() => setSelectedAttachment(null)}
      />
    </div>
  );
}
