import { createMemo, createSignal, For, Show } from "solid-js";
import type { ConversationMediaAttachment } from "../lib/api";
import { createKeyedRecords } from "../lib/createKeyedRecords";
import { useConversationMedia } from "../lib/queries";
import InfiniteScrollSentinel from "./media/InfiniteScrollSentinel";
import { formatMonthKey, groupByMonth } from "./media/mediaGrouping";
import { MediaTile, type MediaThumbItem } from "./media/MediaThumbnail";

type MimeFilter = "" | "image" | "video" | "audio";

const FILTERS: { label: string; value: MimeFilter }[] = [
  { label: "All", value: "" },
  { label: "Images", value: "image" },
  { label: "Videos", value: "video" },
  { label: "Audio", value: "audio" },
];

function mediaUrl(attachment: ConversationMediaAttachment): string {
  return `/api/media/${attachment.storage_path}`;
}

function toMediaItem(attachment: ConversationMediaAttachment): MediaThumbItem {
  return {
    thumbhash: attachment.thumbhash,
    mimeType: attachment.mime_type,
    filename: attachment.filename,
    durationMs: attachment.duration_ms,
    description: attachment.description,
  };
}

export default function MediaGallery(props: {
  conversationId: string;
  source: string;
  sourceAccount?: string;
}) {
  const [filter, setFilter] = createSignal<MimeFilter>("");
  const mediaQuery = useConversationMedia(() => ({
    conversationId: props.conversationId,
    source: props.source,
    sourceAccount: props.sourceAccount,
    mime: filter() || undefined,
  }));
  const attachments = createMemo(() => {
    if (mediaQuery.isPending || mediaQuery.isLoadingError) return [];
    return mediaQuery.data?.pages.flatMap((page) => page.attachments) ?? [];
  });

  const observerVersion = () =>
    `${props.source}\0${props.sourceAccount ?? ""}\0${props.conversationId}\0${filter()}\0${mediaQuery.dataUpdatedAt}`;

  const monthGroupRecords = createKeyedRecords(
    () => Array.from(groupByMonth(attachments()), ([month, items]) => ({ month, items })),
    (group) => group.month,
  );

  return (
    <div class="px-4">
      {/* Filter pills */}
      <div class="flex gap-1 flex-wrap py-3">
        <For each={FILTERS}>
          {(f) => (
            <button
              class={`px-2 py-0.5 text-xs rounded-full transition-colors cursor-pointer ${
                filter() === f.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-accent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          )}
        </For>
      </div>

      {/* Loading state */}
      <Show when={mediaQuery.isPending}>
        <div class="grid grid-cols-3 gap-1">
          <For each={[1, 2, 3, 4, 5, 6]}>
            {() => (
              <div class="aspect-square bg-accent rounded-sm animate-pulse" />
            )}
          </For>
        </div>
      </Show>

      {/* Error state */}
      <Show when={mediaQuery.isError}>
        <div class="text-center text-red-500 text-sm py-8">
          Failed to load media
        </div>
      </Show>

      {/* Empty state */}
      <Show when={mediaQuery.isSuccess && attachments().length === 0}>
        <div class="text-center text-muted-foreground text-sm py-8">
          No media found
        </div>
      </Show>

      {/* Media grid grouped by month */}
      <Show when={attachments().length > 0}>
        <For each={monthGroupRecords()}>
          {(record) => {
            const group = record.value;
            return (
            <div class="mb-2">
              <h4 class="text-xs text-muted-foreground mb-1 sticky top-0 z-10 bg-card py-1 -mx-4 px-4">
                {formatMonthKey(group().month)}
              </h4>
              <div class="grid grid-cols-3 gap-1">
                <For each={group().items}>
                  {(att) => (
                    <MediaTile
                      item={toMediaItem(att)}
                      src={mediaUrl(att)}
                      href={mediaUrl(att)}
                      target="_blank"
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
        hasNextPage={mediaQuery.hasNextPage}
        isFetchingNextPage={mediaQuery.isFetchingNextPage}
        onLoadMore={() => void mediaQuery.fetchNextPage()}
      />

      {/* Loading more indicator */}
      <Show when={mediaQuery.isFetchingNextPage}>
        <div class="flex justify-center py-2">
          <div class="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </Show>
    </div>
  );
}
