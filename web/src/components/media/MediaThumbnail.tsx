import { createSignal, Show } from "solid-js";
import { getThumbhashUrl } from "../../lib/thumbhash";
import { IconAttachFile, IconMusicNote, IconPlayArrow } from "../../ui/icons";
import { formatDuration } from "./mediaGrouping";

/**
 * Normalized shape shared by the conversation media gallery and the global
 * attachments browser, decoupled from either API's row naming.
 */
export interface MediaThumbItem {
  thumbhash: string | null;
  mimeType: string | null;
  filename: string | null;
  durationMs: number | null;
  description: string | null;
}

interface MediaTileProps {
  item: MediaThumbItem;
  /** URL of the media file itself (image/video/audio source). */
  src: string;
  /** Where the tile links to when clicked. */
  href: string;
  /** Anchor target; "_blank" opens the media in a new tab. */
  target?: string;
  /**
   * Optional plain-click handler. When provided, an unmodified left click is
   * intercepted (e.g. to open an in-app modal) while modifier/middle clicks and
   * keyboard navigation still follow `href` — progressive enhancement.
   */
  onSelect?: (event: MouseEvent) => void;
}

function linkRel(target: string | undefined): string | undefined {
  return target === "_blank" ? "noopener noreferrer" : undefined;
}

function ImageThumbnail(props: MediaTileProps) {
  const [loaded, setLoaded] = createSignal(false);
  const [errored, setErrored] = createSignal(false);
  const thumbhashUrl = getThumbhashUrl(props.item);

  return (
    <a
      href={props.href}
      target={props.target}
      rel={linkRel(props.target)}
      onClick={props.onSelect}
      class="block aspect-square rounded-sm overflow-hidden relative bg-muted group"
      title={props.item.description || undefined}
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
      {/* Hidden once the media file fails to load so the thumbhash (or a plain
          muted tile) shows instead of the browser's broken-image glyph. */}
      <Show when={!errored()}>
        <img
          src={props.src}
          alt={props.item.filename || "Image"}
          class={`w-full h-full object-cover transition-opacity duration-300 ${thumbhashUrl ? (loaded() ? "opacity-100 group-hover:opacity-90" : "opacity-0") : "group-hover:opacity-90"}`}
          loading="lazy"
          fetchpriority="low"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      </Show>
    </a>
  );
}

function VideoThumbnail(props: MediaTileProps) {
  const thumbhashUrl = getThumbhashUrl(props.item);

  return (
    <a
      href={props.href}
      target={props.target}
      rel={linkRel(props.target)}
      onClick={props.onSelect}
      class="block aspect-square rounded-sm overflow-hidden relative bg-muted group"
      title={props.item.description || undefined}
    >
      <Show when={thumbhashUrl}>
        {(url) => (
          <img
            src={url()}
            alt=""
            aria-hidden="true"
            class="absolute inset-0 w-full h-full object-cover pointer-events-none"
          />
        )}
      </Show>
      {/* Play icon overlay */}
      <div class="absolute inset-0 flex items-center justify-center">
        <div class="w-8 h-8 rounded-full bg-black/60 flex items-center justify-center text-white group-hover:bg-black/80 transition-colors">
          <IconPlayArrow class="w-4 h-4 ml-0.5" />
        </div>
      </div>
      {/* Duration badge */}
      <Show when={props.item.durationMs}>
        {(ms) => (
          <div class="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-1 rounded">
            {formatDuration(ms())}
          </div>
        )}
      </Show>
    </a>
  );
}

function AudioThumbnail(props: MediaTileProps) {
  return (
    <a
      href={props.href}
      target={props.target}
      rel={linkRel(props.target)}
      onClick={props.onSelect}
      class="flex items-center gap-2 p-2 rounded-sm bg-muted text-sm col-span-full hover:bg-accent transition-colors"
      title={props.item.description || undefined}
    >
      <IconMusicNote class="h-4 w-4 shrink-0" aria-hidden />
      <span class="truncate text-foreground">{props.item.filename || "Audio"}</span>
      <Show when={props.item.durationMs}>
        {(ms) => (
          <span class="text-muted-foreground text-xs shrink-0">{formatDuration(ms())}</span>
        )}
      </Show>
    </a>
  );
}

function FileThumbnail(props: MediaTileProps) {
  const ext = () => props.item.filename?.split(".").pop()?.toLowerCase() || "";
  const label = () => props.item.description || props.item.filename || "Attachment";

  return (
    <a
      href={props.href}
      target={props.target}
      rel={linkRel(props.target)}
      onClick={props.onSelect}
      class="aspect-square rounded-sm overflow-hidden bg-muted flex flex-col items-center justify-center gap-1 text-muted-foreground hover:bg-accent transition-colors"
      title={props.item.description || undefined}
      aria-label={label()}
    >
      <IconAttachFile class="h-5 w-5" aria-hidden />
      <Show when={ext()}>
        <span class="text-[10px] uppercase font-medium">{ext()}</span>
      </Show>
    </a>
  );
}

/**
 * Renders the appropriate thumbnail variant (image / video / audio / file)
 * for a normalized media item.
 */
export function MediaTile(props: MediaTileProps) {
  return (
    <Show
      when={props.item.mimeType?.startsWith("image/")}
      fallback={
        <Show
          when={props.item.mimeType?.startsWith("video/")}
          fallback={
            <Show
              when={props.item.mimeType?.startsWith("audio/")}
              fallback={<FileThumbnail {...props} />}
            >
              <AudioThumbnail {...props} />
            </Show>
          }
        >
          <VideoThumbnail {...props} />
        </Show>
      }
    >
      <ImageThumbnail {...props} />
    </Show>
  );
}
