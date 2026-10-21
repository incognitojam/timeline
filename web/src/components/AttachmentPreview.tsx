import { createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Attachment } from "../lib/api";
import { formatFileSize, getFileIcon } from "../lib/format";
import { getThumbhashUrl } from "../lib/thumbhash";
import { IconCancel, IconHourglass } from "../ui/icons";

/**
 * Build a style object for a container div with aspect-ratio sizing.
 */
function containerStyle(
  attachment: Attachment,
  defaultMinHeight: string
): Record<string, string> {
  const style: Record<string, string> = {};

  if (attachment.width && attachment.height) {
    style["aspect-ratio"] = `${attachment.width} / ${attachment.height}`;
    style["max-height"] = "15rem";
  } else {
    style["min-height"] = defaultMinHeight;
  }

  return style;
}

/**
 * Image attachment with thumbhash placeholder that hides on load.
 * Uses a separate placeholder layer so transparent PNGs don't bleed through.
 */
export function ImageWithPlaceholder(props: { attachment: Attachment }) {
  const [loaded, setLoaded] = createSignal(false);
  const thumbhashUrl = getThumbhashUrl(props.attachment);

  return (
    <div
      class="max-w-sm rounded overflow-hidden relative"
      style={containerStyle(props.attachment, "8rem")}
    >
      {/* Thumbhash placeholder — fades out after real image loads + paints */}
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
      <a
        href={`/api/media/${props.attachment.storage_path}`}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title={props.attachment.description || undefined}
      >
        <img
          src={`/api/media/${props.attachment.storage_path}`}
          alt={props.attachment.filename || "Attachment"}
          class={`max-w-full max-h-60 rounded cursor-pointer object-contain object-left-top relative transition-opacity duration-300 ${thumbhashUrl ? (loaded() ? "opacity-100 hover:opacity-90" : "opacity-0") : "hover:opacity-90"}`}
          loading="lazy"
          width={props.attachment.width || undefined}
          height={props.attachment.height || undefined}
          onLoad={() => setLoaded(true)}
        />
      </a>
    </div>
  );
}

/**
 * Card for non-media attachments (PDFs, archives, docs, etc.) — clickable
 * link that opens the file via the media endpoint in a new tab.
 */
function FileCard(props: { attachment: Attachment }) {
  const filename = () => props.attachment.filename || "Attachment";
  return (
    <a
      href={`/api/media/${props.attachment.storage_path}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      class="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50 border border-border/50 text-sm hover:bg-muted transition-colors max-w-sm"
      title={props.attachment.description || filename()}
    >
      <Dynamic
        component={getFileIcon(props.attachment.filename, props.attachment.mime_type)}
        class="h-4 w-4 shrink-0"
        aria-hidden
      />
      <div class="min-w-0">
        <div class="truncate font-medium">{filename()}</div>
        <Show when={props.attachment.file_size}>
          {(size) => (
            <div class="text-sm text-muted-foreground">{formatFileSize(size())}</div>
          )}
        </Show>
      </div>
    </a>
  );
}

export default function AttachmentPreview(props: { attachments: Attachment[] }) {
  return (
    <Show when={props.attachments.length > 0}>
      <div class="flex flex-wrap gap-2 mt-2">
        <For each={props.attachments}>
          {(attachment) => (
            <Show
              when={attachment.status === "stored" && attachment.storage_path}
              fallback={
                <div
                  class="w-20 h-20 bg-muted rounded flex items-center justify-center text-muted-foreground text-xs"
                  role="img"
                  aria-label={
                    attachment.status === "pending"
                      ? "Attachment pending"
                      : "Attachment unavailable"
                  }
                >
                  <Show
                    when={attachment.status === "pending"}
                    fallback={<IconCancel class="h-4 w-4" aria-hidden />}
                  >
                    <IconHourglass class="h-4 w-4" aria-hidden />
                  </Show>
                </div>
              }
            >
              <Show
                when={attachment.mime_type?.startsWith("image/")}
                fallback={
                  <Show
                    when={attachment.mime_type?.startsWith("video/")}
                    fallback={
                      <Show
                        when={attachment.mime_type?.startsWith("audio/")}
                        fallback={<FileCard attachment={attachment} />}
                      >
                        <audio
                          src={`/api/media/${attachment.storage_path}`}
                          controls
                          preload="metadata"
                          class="max-w-sm rounded"
                          title={attachment.description || undefined}
                        />
                      </Show>
                    }
                  >
                    {/* Video container with aspect-ratio sizing */}
                    <div
                      class="max-w-sm rounded overflow-hidden"
                      style={containerStyle(attachment, "10rem")}
                      title={attachment.description || undefined}
                    >
                      <video
                        src={`/api/media/${attachment.storage_path}`}
                        controls
                        preload="metadata"
                        class="w-full h-full rounded object-contain"
                      />
                    </div>
                  </Show>
                }
              >
                <ImageWithPlaceholder attachment={attachment} />
              </Show>
            </Show>
          )}
        </For>
      </div>
    </Show>
  );
}
