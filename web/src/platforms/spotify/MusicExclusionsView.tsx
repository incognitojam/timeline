import type { MusicExclusionKind, MusicExclusionsResponse, MusicTopListFilter } from "@platforms/spotify/shared/music";
import { A } from "@solidjs/router";
import { For, Match, Show, Switch } from "solid-js";
import { formatRelativeDate } from "../../lib/format";
import {
  useExcludeFromTopLists,
  useExcludePrivateSessions,
  useIncludeInTopLists,
  useMusicExclusions,
} from "../../lib/queries";
import { ROUTES } from "../../lib/routes";
import { IconMoreHoriz } from "../../ui/icons";

const EXCLUSION_KIND_LABELS: Record<MusicExclusionKind, string> = {
  track: "Track",
  album: "Album",
  artist: "Artist",
  playlist: "Playlist",
};

function PrivateSessionsSwitch(props: { filter: MusicTopListFilter }) {
  const privateSessions = useExcludePrivateSessions();
  const excludingPrivate = () => privateSessions.isPending
    ? privateSessions.variables === true
    : props.filter.excludePrivateSessions;
  return (
    <div class="rounded-xl bg-card">
      <button
        type="button"
        role="switch"
        aria-checked={excludingPrivate()}
        disabled={privateSessions.isPending}
        class="flex w-full items-center gap-4 rounded-xl px-4 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50 motion-reduce:transition-none"
        onClick={() => privateSessions.mutate(!excludingPrivate())}
      >
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium">Leave private-session plays out of top lists</span>
          <span class="block text-xs text-muted-foreground">
            Plays from a Spotify private session stay on your timeline.
          </span>
        </span>
        <span
          aria-hidden="true"
          class={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${excludingPrivate() ? "bg-primary" : "bg-muted"}`}
        >
          <span
            class={`absolute left-0 top-0.5 h-4 w-4 rounded-full transition-transform motion-reduce:transition-none ${excludingPrivate() ? "translate-x-4.5 bg-primary-foreground" : "translate-x-0.5 bg-muted-foreground"}`}
          />
        </span>
      </button>
      <Show when={privateSessions.isError}>
        <p class="px-4 pb-3 text-xs text-red-500">Could not save that change. Try again.</p>
      </Show>
    </div>
  );
}

function ExclusionList(props: { filter: MusicTopListFilter }) {
  const include = useIncludeInTopLists();
  return (
    <section aria-labelledby="excluded-heading" class="space-y-3">
      <div class="flex items-center gap-2">
        <h2 id="excluded-heading" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Excluded
        </h2>
        <span class="h-px flex-1 bg-border" />
        <Show when={props.filter.exclusions.length > 0}>
          <span class="font-mono text-xs tabular-nums text-muted-foreground">
            {props.filter.exclusions.length.toLocaleString()}
          </span>
        </Show>
      </div>
      <Show when={include.isError}>
        <p class="text-xs text-red-500">Could not include it again. Try again.</p>
      </Show>
      <Show
        when={props.filter.exclusions.length > 0}
        fallback={
          <p class="rounded-xl bg-card px-4 py-6 text-sm text-muted-foreground">
            No tracks, albums, artists or playlists excluded. Use{" "}
            <IconMoreHoriz class="inline h-4 w-4 align-text-bottom" aria-label="the row menu" />{" "}
            on a row of the Music page, or a playlist below, to leave one out of the top lists.
          </p>
        }
      >
        <ul class="divide-y divide-border rounded-xl bg-card">
          <For each={props.filter.exclusions}>
            {(exclusion) => (
              <li class="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span class="w-16 shrink-0 text-[11px] uppercase tracking-wider text-muted-foreground">
                  {EXCLUSION_KIND_LABELS[exclusion.kind]}
                </span>
                <span class="min-w-0 flex-1 truncate">{exclusion.label}</span>
                <button
                  type="button"
                  class="shrink-0 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50"
                  disabled={include.isPending}
                  onClick={() => include.mutate(exclusion.id)}
                >
                  Include again
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

function PlayedPlaylists(props: { exclusions: MusicExclusionsResponse }) {
  const exclude = useExcludeFromTopLists();
  // Success only while it is still excluded: "Include again" above would make it untrue.
  const feedback = () => {
    if (exclude.isError) return "Could not exclude that playlist. Try again.";
    const exclusion = exclude.data;
    return exclusion && props.exclusions.exclusions.some((e) => e.id === exclusion.id)
      ? `${exclusion.label} left out of top lists.`
      : "";
  };
  return (
    <section aria-labelledby="played-playlists-heading" class="space-y-3">
      <div class="flex items-center gap-2">
        <h2 id="played-playlists-heading" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Playlists you've played from
        </h2>
        <span class="h-px flex-1 bg-border" />
      </div>
      {/* Mounted throughout, so screen readers announce each change to its text. */}
      <p role="status" class={`text-xs empty:hidden ${exclude.isError ? "text-red-500" : "text-muted-foreground"}`}>
        {feedback()}
      </p>
      <Show
        when={props.exclusions.playedPlaylists.length > 0}
        fallback={
          <p class="rounded-xl bg-card px-4 py-6 text-sm text-muted-foreground">
            {props.exclusions.exclusions.some((e) => e.kind === "playlist")
              ? "Every playlist you've played from is excluded."
              : "The live sync has not recorded plays from any playlist yet."}
          </p>
        }
      >
        <ul class="divide-y divide-border rounded-xl bg-card">
          <For each={props.exclusions.playedPlaylists}>
            {(playlist) => (
              <li class="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{playlist.name}</span>
                  <span class="block text-xs text-muted-foreground">
                    {playlist.plays.toLocaleString()} {playlist.plays === 1 ? "play" : "plays"} · last played{" "}
                    {formatRelativeDate(playlist.lastPlayedAt)}
                  </span>
                </span>
                <button
                  type="button"
                  class="shrink-0 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-50"
                  aria-label={`Exclude ${playlist.name}`}
                  disabled={exclude.isPending}
                  onClick={() => exclude.mutate({ kind: "playlist", playlistUri: playlist.playlistUri })}
                >
                  Exclude
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="text-xs text-muted-foreground">
        Only playlists the live sync saw you play from are listed. Export history does not record
        playlists, so the plays it imported still count when their playlist is excluded.
      </p>
    </section>
  );
}

export default function MusicExclusionsView() {
  const exclusionsQuery = useMusicExclusions();
  return (
    <div class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
        <div>
          <A href={ROUTES.MUSIC} class="text-xs text-muted-foreground hover:text-foreground">
            ← Music
          </A>
          <h1 class="font-display text-2xl font-medium mt-1">Excluded from top lists</h1>
          <p class="mt-1 text-sm text-muted-foreground">
            Excluded plays still count in Plays and stay everywhere else in Timeline.
          </p>
        </div>

        <Switch>
          <Match when={exclusionsQuery.isPending}>
            <div class="h-16 rounded-xl bg-card animate-pulse motion-reduce:animate-none" />
            <div class="h-32 rounded-xl bg-card animate-pulse motion-reduce:animate-none" />
          </Match>
          <Match when={exclusionsQuery.isLoadingError}>
            <div class="p-4 rounded-lg bg-card text-sm text-red-500">Failed to load exclusions.</div>
          </Match>
          <Match when={exclusionsQuery.data}>
            {(exclusions) => (
              <>
                <PrivateSessionsSwitch filter={exclusions()} />
                <ExclusionList filter={exclusions()} />
                <PlayedPlaylists exclusions={exclusions()} />
              </>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  );
}
