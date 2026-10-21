import { Show, For } from "solid-js";
import { useContactSpotifySummary } from "../lib/queries";
import { staleContentClass } from "../lib/stale-content";

interface Props {
  contactId: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export default function ContactSpotifySummary(props: Props) {
  const query = useContactSpotifySummary(() => props.contactId);

  return (
    <Show when={!query.isPending && !query.isError && query.data?.summary}>
      {(summary) => (
        <div class={`rounded-lg bg-card p-4 ${staleContentClass(query.isPlaceholderData)}`} aria-busy={query.isPlaceholderData}>
          <div class="flex items-center justify-between mb-3">
            <h3 class="text-sm font-medium text-muted-foreground">Spotify Activity</h3>
            <div class="text-xs text-muted-foreground">
              {summary().totalListens.toLocaleString()} listens
              <Show when={summary().firstListen}>
                {(ts) => <> since {formatDate(ts())}</>}
              </Show>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-4">
            {/* Top Artists */}
            <div>
              <h4 class="text-xs font-medium text-muted-foreground mb-2">Top Artists</h4>
              <div class="space-y-1">
                <For each={summary().topArtists.slice(0, 5)}>
                  {(artist, i) => (
                    <div class="flex items-center gap-2 text-sm">
                      <span class="text-xs text-muted-foreground w-4 text-right">{i() + 1}.</span>
                      <span class="truncate flex-1">{artist.name}</span>
                      <span class="text-xs text-muted-foreground font-mono tabular-nums">{artist.listenCount}</span>
                    </div>
                  )}
                </For>
              </div>
            </div>

            {/* Top Tracks */}
            <div>
              <h4 class="text-xs font-medium text-muted-foreground mb-2">Top Tracks</h4>
              <div class="space-y-1">
                <For each={summary().topTracks.slice(0, 5)}>
                  {(track, i) => (
                    <div class="flex items-center gap-2 text-sm">
                      <span class="text-xs text-muted-foreground w-4 text-right">{i() + 1}.</span>
                      <div class="truncate flex-1">
                        <span>{track.name}</span>
                        <Show when={track.artist}>
                          <span class="text-muted-foreground"> — {track.artist}</span>
                        </Show>
                      </div>
                      <span class="text-xs text-muted-foreground font-mono tabular-nums">{track.listenCount}</span>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
