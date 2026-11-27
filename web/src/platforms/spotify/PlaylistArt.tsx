import { Show } from "solid-js";
import { IconMusicNote } from "../../ui/icons";

/**
 * Square Spotify playlist cover art. Falls back to a muted placeholder with a
 * music-note glyph when no image has been cached yet (e.g. before the first
 * spotify-playlists sync runs, or for playlists with no cover).
 *
 * Pass sizing/shape via `class` (e.g. "h-12 w-12"). `transitionName` names it
 * for a shared-element view transition (see lib/view-transition.ts); `eager`
 * loads it at once where it must be ready for that transition's snapshot.
 */
export default function PlaylistArt(props: {
  src: string | null;
  name?: string | null;
  class?: string;
  transitionName?: string;
  eager?: boolean;
}) {
  return (
    <Show
      when={props.src}
      fallback={
        <div
          class={`flex items-center justify-center rounded-md bg-accent text-muted-foreground ${props.class ?? ""}`}
          aria-hidden="true"
          style={{ "view-transition-name": props.transitionName }}
        >
          <IconMusicNote class="w-[45%] h-[45%]" />
        </div>
      }
    >
      {(src) => (
        <img
          src={src()}
          alt={props.name ? `${props.name} cover art` : "Playlist cover art"}
          loading={props.eager ? "eager" : "lazy"}
          class={`rounded-md object-cover ${props.class ?? ""}`}
          style={{ "view-transition-name": props.transitionName }}
        />
      )}
    </Show>
  );
}
