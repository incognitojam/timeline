import { Show, For, createSignal, createMemo } from "solid-js";
import type { EventGroupData } from "@shared/grouping";
import { sourceLabel } from "@shared/sources";
import type { Attachment } from "../../lib/api";
import type { TimelineEvent } from "../../lib/types";
import { getSourceColorStyle } from "../../lib/source-styles";
import SourceIcon from "../SourceIcon";
import { getThumbhashUrl } from "../../lib/thumbhash";
import { IconChevronDown } from "../../ui/icons";
import { formatTime } from "../../lib/format";

interface Props {
  group: EventGroupData<TimelineEvent>;
  attachmentsByEvent: Record<number, Attachment[]>;
  isHighlighted?: boolean;
  highlightEventId?: number;
  setEventRef?: (eventId: number, el: HTMLDivElement) => void;
}

// Strip never grows beyond this; anything more requires expanding the card.
const STRIP_TILE_LIMIT = 5;

function formatTimeRange(start: string | null, end: string | null): string {
  if (!start) return "";
  const s = formatTime(start);
  if (!end || start === end) return s;
  return `${s} – ${formatTime(end)}`;
}

// Pick N evenly-spaced events from a session so the thumbnail strip shows the
// arc of activity rather than 4 consecutive frames of the same window.
function sampleEvenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const result: T[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor((i * items.length) / n);
    result.push(items[idx]);
  }
  return result;
}

function ThumbnailTile(props: { event: TimelineEvent; attachment: Attachment | undefined }) {
  const [loaded, setLoaded] = createSignal(false);
  // Narrow to an attachment that actually has a storage_path so we can use it
  // without non-null assertions inside the rendered <a>.
  const storedAttachment = (): Attachment | null => {
    const a = props.attachment;
    return a && a.storage_path ? a : null;
  };
  const thumbhashUrl = () => {
    const a = storedAttachment();
    return a ? getThumbhashUrl(a) : null;
  };

  return (
    <Show
      when={storedAttachment()}
      fallback={
        <div class="aspect-video bg-muted rounded-sm flex items-center justify-center text-xs text-muted-foreground">
          —
        </div>
      }
    >
      {(att) => (
        <a
          href={`/api/media/${att().storage_path}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          class="block aspect-video rounded-sm overflow-hidden relative bg-muted group/tile"
          title={att().description || `${props.event.title ?? ""} · ${formatTime(props.event.timestamp)}`}
        >
          <Show when={thumbhashUrl()}>
            {(url) => (
              <img
                src={url()}
                alt=""
                aria-hidden="true"
                class={`absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-300 ${loaded() ? "opacity-0" : "opacity-100"}`}
              />
            )}
          </Show>
          <img
            src={`/api/media/${att().storage_path}`}
            alt={att().filename || "Screen capture"}
            loading="lazy"
            class={`relative w-full h-full object-cover transition-opacity duration-300 group-hover/tile:opacity-90 ${thumbhashUrl() ? (loaded() ? "opacity-100" : "opacity-0") : ""}`}
            onLoad={() => setLoaded(true)}
          />
          <span class="absolute bottom-0 left-0 right-0 px-1.5 py-0.5 text-[10px] text-white bg-black/60 truncate">
            {formatTime(props.event.timestamp)}
          </span>
        </a>
      )}
    </Show>
  );
}

export default function RecallSessionCard(props: Props) {
  const [expanded, setExpanded] = createSignal(false);
  const colorStyle = () => getSourceColorStyle(props.group.source);

  const events = createMemo(() =>
    [...props.group.events].sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return ta - tb;
    })
  );

  // Thumbnail strip: up to N evenly-spaced captures (start, ¼, ½, ¾, end-ish).
  const stripEvents = createMemo(() => sampleEvenly(events(), STRIP_TILE_LIMIT));

  // Expanding only reveals new info when the strip can't fit every capture.
  const canExpand = () => events().length > STRIP_TILE_LIMIT;
  const totalCaptures = () => events().length;

  const handleHeaderClick = () => {
    if (!canExpand()) return;
    setExpanded(!expanded());
  };

  return (
    <div class="relative pl-8 pb-4">
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center source-icon"
        style={colorStyle()}
      >
        <SourceIcon source={props.group.source} class="w-3 h-3" />
      </div>

      <div
        class={`rounded-lg bg-card transition-colors ${
          props.isHighlighted ? "ring-2 ring-ring" : ""
        }`}
      >
        <button
          type="button"
          disabled={!canExpand()}
          class={`w-full p-3 transition-colors rounded-t-lg text-left ${
            canExpand() ? "hover:bg-accent/30 cursor-pointer" : "cursor-default"
          }`}
          onClick={handleHeaderClick}
        >
          <div class="flex items-start gap-2 mb-2">
            <span class="text-xs text-muted-foreground shrink-0 w-12">
              {formatTime(props.group.timeRange.start)}
            </span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs px-1.5 py-0.5 rounded source-badge" style={colorStyle()}>
                  {sourceLabel(props.group.source)}
                </span>
                <span class="text-xs text-muted-foreground">{props.group.summary}</span>
                <span class="text-xs text-muted-foreground">
                  · {formatTimeRange(props.group.timeRange.start, props.group.timeRange.end)}
                </span>
              </div>
              <p class="text-sm font-medium truncate">{props.group.label}</p>
            </div>
            <Show when={canExpand()}>
              <div class="shrink-0 text-muted-foreground">
                <IconChevronDown class={`w-4 h-4 transition-transform ${expanded() ? "rotate-180" : ""}`} />
              </div>
            </Show>
          </div>

          {/* Thumbnail strip — fits in the header so the gist of the session
              is visible without expanding. */}
          <div class="grid grid-cols-5 gap-1.5 pl-14">
            <For each={stripEvents()}>
              {(event) => (
                <ThumbnailTile
                  event={event}
                  attachment={props.attachmentsByEvent[event.id]?.[0]}
                />
              )}
            </For>
          </div>
        </button>

        <Show when={expanded() && canExpand()}>
          <div class="border-t border-border p-3 pl-14">
            <p class="text-xs text-muted-foreground mb-2">
              All {totalCaptures()} captures
            </p>
            <div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-x-1.5 gap-y-2">
              <For each={events()}>
                {(event) => (
                  <div
                    id={`event-${event.id}`}
                    ref={(el) => props.setEventRef?.(event.id, el)}
                    class={
                      event.id === props.highlightEventId
                        ? "ring-2 ring-ring rounded-sm"
                        : ""
                    }
                  >
                    <ThumbnailTile
                      event={event}
                      attachment={props.attachmentsByEvent[event.id]?.[0]}
                    />
                    {/* Time + frontmost app under each tile so a long
                        session can be skimmed for the moment you want. */}
                    <p class="mt-1 text-[11px] text-muted-foreground truncate" title={event.title ?? undefined}>
                      <span class="tabular-nums">{formatTime(event.timestamp)}</span>
                      <Show when={event.title}>
                        <span> · {event.title}</span>
                      </Show>
                    </p>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
