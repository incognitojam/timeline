import { Show, createSignal } from "solid-js";
import { sourceLabel } from "@shared/sources";
import type { Attachment } from "../../lib/api";
import type { TimelineEvent } from "../../lib/types";
import { getSourceColorStyle } from "../../lib/source-styles";
import { getThumbhashUrl } from "../../lib/thumbhash";
import { formatTime } from "../../lib/format";
import SourceIcon from "../SourceIcon";

interface Props {
  event: TimelineEvent;
  attachment?: Attachment;
  isHighlighted?: boolean;
}

function ScreenshotThumbnail(props: { attachment: Attachment }) {
  const [loaded, setLoaded] = createSignal(false);
  const thumbhashUrl = getThumbhashUrl(props.attachment);
  const aspect = () => {
    const a = props.attachment;
    if (a.width && a.height) return `${a.width} / ${a.height}`;
    return "16 / 9";
  };

  return (
    <a
      href={`/api/media/${props.attachment.storage_path}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      class="block max-w-md rounded-sm overflow-hidden relative bg-muted"
      style={{ "aspect-ratio": aspect() }}
      title={props.attachment.description || undefined}
    >
      <Show when={thumbhashUrl}>
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
        src={`/api/media/${props.attachment.storage_path}`}
        alt={props.attachment.filename || "Screen capture"}
        loading="lazy"
        class={`relative w-full h-full object-cover transition-opacity duration-300 hover:opacity-90 ${thumbhashUrl ? (loaded() ? "opacity-100" : "opacity-0") : ""}`}
        onLoad={() => setLoaded(true)}
      />
    </a>
  );
}

export default function RecallCard(props: Props) {
  const colorStyle = () => getSourceColorStyle(props.event.source);
  const frontmostApp = () => props.event.title;

  return (
    <div class={`relative pl-8 pb-4 ${props.isHighlighted ? "ring-2 ring-ring rounded-lg" : ""}`}>
      <div class="absolute left-3 top-0 bottom-0 w-px bg-border timeline-spine" />
      <div
        class="absolute left-1 top-1 w-5 h-5 rounded-full flex items-center justify-center source-icon"
        style={colorStyle()}
      >
        <SourceIcon source={props.event.source} class="w-3 h-3" />
      </div>

      <div class={`group rounded-lg bg-card p-3 transition-colors hover:bg-accent/30 ${props.isHighlighted ? "bg-accent" : ""}`}>
        <div class="flex items-start gap-2">
          <span class="text-xs text-muted-foreground shrink-0">
            {formatTime(props.event.timestamp)}
          </span>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs px-1.5 py-0.5 rounded source-badge" style={colorStyle()}>
                {sourceLabel(props.event.source)}
              </span>
              <span class="text-xs text-muted-foreground">screen capture</span>
              <Show when={props.event.source_account}>
                <span class="text-xs text-muted-foreground" title="Host">
                  &middot; {props.event.source_account}
                </span>
              </Show>
            </div>

            <Show when={frontmostApp()}>
              <p class="text-sm font-medium truncate mb-2">{frontmostApp()}</p>
            </Show>

            <Show
              when={props.attachment?.storage_path ? props.attachment : null}
              fallback={
                <Show when={props.attachment}>
                  <div class="max-w-md aspect-video rounded-sm bg-muted flex items-center justify-center text-xs text-muted-foreground">
                    Screenshot processing...
                  </div>
                </Show>
              }
            >
              {(att) => <ScreenshotThumbnail attachment={att()} />}
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
