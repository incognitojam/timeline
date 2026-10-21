import { Show } from "solid-js";
import { IconMusicNote } from "../ui/icons";

/**
 * Square Spotify playlist cover art. Falls back to a muted placeholder with a
 * music-note glyph when no image has been cached yet (e.g. before the first
 * spotify-playlists sync runs, or for playlists with no cover).
 *
 * Pass sizing/shape via `class` (e.g. "h-12 w-12").
 */
export default function PlaylistArt(props: {
  src: string | null;
  name?: string | null;
  class?: string;
}) {
  return (
    <Show
      when={props.src}
      fallback={
        <div
          class={`flex items-center justify-center rounded-md bg-accent text-muted-foreground ${props.class ?? ""}`}
          aria-hidden="true"
        >
          <IconMusicNote class="w-[45%] h-[45%]" />
        </div>
      }
    >
      {(src) => (
        <img
          src={src()}
          alt={props.name ? `${props.name} cover art` : "Playlist cover art"}
          loading="lazy"
          class={`rounded-md object-cover ${props.class ?? ""}`}
        />
      )}
    </Show>
  );
}
