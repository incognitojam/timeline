import type {
  MusicPeriod,
  MusicRankedArtist,
  MusicRankedTrack,
  MusicRankingsOverview,
  MusicRecentPlay,
} from "@shared/music";
import { A } from "@solidjs/router";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import {
  type SpotifyFriendLatestListen,
  type TrackedPlaylist,
} from "../lib/api";
import { formatDuration } from "../lib/format";
import { creationAnchor, pastYearSaves } from "../lib/playlist-stats";
import {
  useMusicFriendListens,
  useMusicPlaylists,
  useMusicRankings,
  useMusicRecent,
} from "../lib/queries";
import { buildContactsUrl, buildEventUrl, buildMusicPlaylistUrl } from "../lib/routes";
import { staleContentClass } from "../lib/stale-content";
import { IconMusicNote } from "../ui/icons";
import SegmentedControl, { type SegmentedControlOption } from "../ui/SegmentedControl";
import Avatar from "./Avatar";
import PlaylistArt from "./PlaylistArt";
import Sparkline from "./Sparkline";

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function PlaylistRow(props: { playlist: TrackedPlaylist }) {
  // A single-reading playlist has nothing for the sparkline to draw (it needs
  // two points), so prepend the artificial 0-saves creation anchor to show a
  // ramp from creation rather than a bare dot. Multi-reading series already
  // draw a real trend — leave them alone rather than flatten the recent shape
  // against a forced 0 y-min.
  const sparkData = () => {
    const series = props.playlist.series;
    if (series.length >= 2) return series.map((pt) => pt.count);
    const a = creationAnchor(props.playlist.createdDate, series);
    return (a ? [a, ...series] : series).map((pt) => pt.count);
  };

  // Recent momentum, matching the detail view's "Past 12 months" headline. The
  // lifetime delta we showed before was dominated by an arbitrary seed baseline
  // (e.g. a reading taken years before live tracking began), so it read as
  // noise. With too few real readings this falls back to a creation-anchored estimate (marked "~").
  const change = () => pastYearSaves(props.playlist.series, props.playlist.createdDate);
  return (
    <A
      href={buildMusicPlaylistUrl(props.playlist.playlistId)}
      class="flex items-center gap-3 px-3 py-2.5 hover:bg-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <PlaylistArt
        src={props.playlist.imageUrl}
        name={props.playlist.name}
        class="h-10 w-10 shrink-0"
      />

      <div class="flex-1 min-w-0">
        <div class="font-medium truncate">
          {props.playlist.name ?? props.playlist.playlistId}
        </div>
        <div
          class="text-xs text-muted-foreground mt-0.5"
          title={
            props.playlist.createdDate
              ? "Playlist created (earliest track added) → last checked"
              : "First tracked → last checked"
          }
        >
          {formatDate(props.playlist.createdDate ?? props.playlist.firstDate)} –{" "}
          {formatDate(props.playlist.latestDate)}
        </div>
      </div>

      <Sparkline data={sparkData()} class="text-green-400 shrink-0" />

      <div class="text-right shrink-0 w-24 hidden sm:block">
        <div class="text-base font-semibold font-mono tabular-nums">
          {props.playlist.latestCount.toLocaleString()}
        </div>
        <Show
          when={change()}
          fallback={
            <div class="text-xs text-muted-foreground" title="Not enough readings yet">
              —
            </div>
          }
        >
          {(py) => (
            <div
              class="text-xs font-mono tabular-nums"
              classList={{
                "text-green-500": py().value > 0,
                "text-red-500": py().value < 0,
                "text-muted-foreground": py().value === 0,
              }}
              title={
                py().estimated
                  ? "Estimated saves gained over the past year (from the creation date)"
                  : "Saves gained over the past 12 months"
              }
            >
              {py().estimated ? "~" : ""}
              {py().value > 0 ? "+" : ""}
              {py().value.toLocaleString()}
              <span class="text-muted-foreground"> past year</span>
            </div>
          )}
        </Show>
      </div>
    </A>
  );
}

function RowSkeleton() {
  return (
    <div class="flex items-center gap-3 px-3 py-2.5">
      <div class="h-10 w-10 shrink-0 bg-accent rounded-md animate-pulse" />
      <div class="flex-1 space-y-2">
        <div class="h-4 w-40 bg-accent rounded animate-pulse" />
        <div class="h-3 w-56 bg-accent rounded animate-pulse" />
      </div>
      <div class="h-7 w-[120px] bg-accent rounded animate-pulse" />
      <div class="h-8 w-24 bg-accent rounded animate-pulse" />
    </div>
  );
}

function formatListenTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function FriendListenRow(props: { friend: SpotifyFriendLatestListen }) {
  const friendName = () => (
    <Show
      when={props.friend.contactId}
      fallback={<span class="font-medium truncate">{props.friend.name}</span>}
    >
      {(contactId) => (
        <A
          href={buildContactsUrl({ id: contactId() })}
          class="font-medium truncate hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 rounded-sm"
        >
          {props.friend.name}
        </A>
      )}
    </Show>
  );

  return (
    <div class="flex gap-3 px-3 py-3">
      <Avatar url={props.friend.avatarUrl} name={props.friend.name} size="md" class="mt-0.5" />
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex items-center gap-2 min-w-0">
          {friendName()}
          <span class="text-[11px] text-muted-foreground shrink-0 font-mono tabular-nums">
            {formatListenTime(props.friend.timestamp)}
          </span>
        </div>
        <A
          href={buildEventUrl(props.friend.eventId)}
          class="group flex items-center gap-2 min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          title="Open timeline event"
        >
          <Show
            when={props.friend.imageUrl}
            fallback={
              <div class="h-8 w-8 shrink-0 rounded bg-accent text-muted-foreground flex items-center justify-center text-xs">
                <IconMusicNote class="h-4 w-4" aria-hidden />
              </div>
            }
          >
            {(imageUrl) => (
              <img
                src={imageUrl()}
                alt=""
                class="h-8 w-8 shrink-0 rounded object-cover"
                loading="lazy"
                referrerpolicy="no-referrer"
              />
            )}
          </Show>
          <div class="min-w-0">
            <div class="text-sm truncate group-hover:underline">{props.friend.trackName}</div>
            <div class="text-xs text-muted-foreground truncate">
              <Show when={props.friend.artistName} fallback="Unknown artist">
                {(artist) => artist()}
              </Show>
              <Show when={props.friend.albumName}>
                <span> · {props.friend.albumName}</span>
              </Show>
            </div>
          </div>
        </A>
      </div>
    </div>
  );
}

function FriendListenSkeleton() {
  return (
    <div class="flex gap-3 px-3 py-3">
      <div class="h-8 w-8 rounded-full bg-accent animate-pulse" />
      <div class="flex-1 space-y-2">
        <div class="h-3.5 w-32 bg-accent rounded animate-pulse" />
        <div class="h-8 w-full bg-accent rounded animate-pulse" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Personal listening (top tracks / artists, recent plays)
// ---------------------------------------------------------------------------

type ListeningKind = "tracks" | "artists";

const KIND_OPTIONS: SegmentedControlOption<ListeningKind>[] = [
  { value: "tracks", label: "Tracks" },
  { value: "artists", label: "Artists" },
];

const PERIOD_OPTIONS: SegmentedControlOption<MusicPeriod>[] = [
  { value: "4w", label: "Last 4 weeks" },
  { value: "6m", label: "Last 6 months" },
  { value: "12m", label: "Last 12 months" },
  { value: "all", label: "All time" },
];

const PERIOD_LABELS: Record<MusicPeriod, string> = {
  "4w": "Last 4 weeks",
  "6m": "Last 6 months",
  "12m": "Last 12 months",
  all: "All time",
};

// Sentence-friendly form of each range, for empty-state copy.
const PERIOD_PHRASES: Record<MusicPeriod, string> = {
  "4w": "in the last 4 weeks",
  "6m": "in the last 6 months",
  "12m": "in the last 12 months",
  all: "in your recorded history",
};

const KIND_HEADINGS: Record<ListeningKind, string> = {
  tracks: "Top tracks",
  artists: "Top artists",
};

// Shared row grammar for every ranked/recent listening row: compact, full-bleed
// hit area with an inset focus ring so the ring stays inside the card's radius.
const LISTENING_ROW_CLASS =
  "group flex items-center gap-3 px-3 py-2 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 motion-reduce:transition-none";

const SKELETON_BAR_CLASS = "bg-accent animate-pulse motion-reduce:animate-none";

const TEXT_BUTTON_CLASS =
  "text-primary hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60";

/** "Feb 3" inside the current year, "Feb 3, 2024" beyond it. */
function formatSpanDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
  return date.toLocaleDateString(undefined, options);
}

function formatClock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRecentDay(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  if (diffDays < 365) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Width of a row's share rule, as a percentage of the chart-topper's plays.
// Floored at 2% so the tail of a long list still reads as a mark, not nothing.
function shareOfTop(playCount: number, topPlayCount: number): number {
  if (topPlayCount <= 0) return 0;
  return Math.max(2, Math.round((playCount / topPlayCount) * 100));
}

/**
 * Hairline share rule pinned to the bottom of a ranked row: the row's plays as
 * a fraction of the #1 entry. Decorative — the play count is next to it.
 */
function ShareRule(props: { percent: number }) {
  return (
    <span
      aria-hidden="true"
      class="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-green-500/45"
      style={{ width: `${props.percent}%` }}
    />
  );
}

/** Column captions for a ranked list; purely visual, rows read fine on their own. */
function RankedListHeader(props: { label: string; art: boolean }) {
  return (
    <div
      aria-hidden="true"
      class="flex items-center gap-3 border-b border-border px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground"
    >
      <span class="w-6 shrink-0 text-right">#</span>
      <Show when={props.art}>
        <span class="w-10 shrink-0" />
      </Show>
      <span class="min-w-0 flex-1">{props.label}</span>
      <span class="w-16 shrink-0 text-right sm:w-20">Plays</span>
      <span class="hidden w-20 shrink-0 text-right sm:block">Time</span>
    </div>
  );
}

function ListeningStats(props: { overview: MusicRankingsOverview }) {
  return (
    <dl class="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 border-b border-border px-3 py-2.5">
      <div class="flex items-baseline gap-2">
        <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Plays</dt>
        <dd class="font-mono text-sm font-semibold tabular-nums">
          {props.overview.totalPlays.toLocaleString()}
        </dd>
      </div>
      <Show when={props.overview.firstPlayedAt}>
        {(firstPlayed) => (
          <div
            class="flex items-baseline gap-2"
            title="First to last play recorded in this range"
          >
            <dt class="text-[11px] uppercase tracking-wider text-muted-foreground">Span</dt>
            <dd class="font-mono text-sm tabular-nums text-muted-foreground">
              {formatSpanDate(firstPlayed())} – {formatSpanDate(props.overview.lastPlayedAt)}
            </dd>
          </div>
        )}
      </Show>
    </dl>
  );
}

function RankedTrackRow(props: { track: MusicRankedTrack; share: number }) {
  return (
    <li class="relative">
      <A
        href={buildEventUrl(props.track.eventId)}
        class={LISTENING_ROW_CLASS}
        title={`Last played ${formatListenTime(props.track.lastPlayedAt)} — open timeline event`}
      >
        <span class="w-6 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
          {props.track.rank}
        </span>
        <PlaylistArt
          src={props.track.imageUrl}
          name={props.track.albumName ?? props.track.trackName}
          class="h-10 w-10 shrink-0"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium group-hover:underline">
            {props.track.trackName}
          </span>
          <span class="block truncate text-xs text-muted-foreground">
            <Show when={props.track.artistName} fallback="Unknown artist">
              {(artist) => artist()}
            </Show>
            <Show when={props.track.albumName}>
              {(album) => <span class="text-muted-foreground/70"> · {album()}</span>}
            </Show>
          </span>
        </span>
        <span class="w-16 shrink-0 text-right sm:w-20">
          <span class="block font-mono text-sm tabular-nums">
            {props.track.playCount.toLocaleString()}
            <span class="sr-only"> plays</span>
          </span>
        </span>
        <span class="hidden w-20 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground sm:block">
          {formatDuration(props.track.listeningMs)}
          <span class="sr-only"> listened</span>
        </span>
      </A>
      <ShareRule percent={props.share} />
    </li>
  );
}

function RankedArtistRow(props: { artist: MusicRankedArtist; share: number }) {
  return (
    <li class="relative">
      <A
        href={buildEventUrl(props.artist.eventId)}
        class={LISTENING_ROW_CLASS}
        title={`Last played ${formatListenTime(props.artist.lastPlayedAt)} — open timeline event`}
      >
        <span class="w-6 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
          {props.artist.rank}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-medium group-hover:underline">
            {props.artist.artistName}
          </span>
          <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Show
              when={props.artist.imageUrl}
              fallback={<span class="h-4 w-4 shrink-0 rounded-xs bg-accent" aria-hidden="true" />}
            >
              {(imageUrl) => (
                <img
                  src={imageUrl()}
                  alt=""
                  loading="lazy"
                  referrerpolicy="no-referrer"
                  class="h-4 w-4 shrink-0 rounded-xs object-cover"
                />
              )}
            </Show>
            <span class="truncate">
              <Show when={props.artist.latestTrackName} fallback="Latest track unknown">
                {(latestTrack) => <>Latest: {latestTrack()}</>}
              </Show>
            </span>
          </span>
        </span>
        <span class="w-16 shrink-0 text-right sm:w-20">
          <span class="block font-mono text-sm tabular-nums">
            {props.artist.playCount.toLocaleString()}
            <span class="sr-only"> plays</span>
          </span>
        </span>
        <span class="hidden w-20 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground sm:block">
          {formatDuration(props.artist.listeningMs)}
          <span class="sr-only"> listened</span>
        </span>
      </A>
      <ShareRule percent={props.share} />
    </li>
  );
}

function RecentPlayRow(props: { play: MusicRecentPlay; latest: boolean }) {
  return (
    <li>
      <A
        href={buildEventUrl(props.play.eventId)}
        class={LISTENING_ROW_CLASS}
        title="Open timeline event"
      >
        <PlaylistArt
          src={props.play.imageUrl}
          name={props.play.albumName ?? props.play.trackName}
          class="h-9 w-9 shrink-0"
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm group-hover:underline">{props.play.trackName}</span>
          <span class="block truncate text-xs text-muted-foreground">
            <Show when={props.play.artistName} fallback="Unknown artist">
              {(artist) => artist()}
            </Show>
          </span>
        </span>
        <span class="flex shrink-0 items-center gap-1.5">
          <Show when={props.latest}>
            <span
              class="h-1.5 w-1.5 rounded-full bg-green-400"
              title="Most recent play"
              aria-hidden="true"
            />
          </Show>
          <time
            datetime={props.play.timestamp}
            class="font-mono text-[11px] tabular-nums text-muted-foreground"
          >
            {formatClock(props.play.timestamp)}
          </time>
        </span>
      </A>
    </li>
  );
}

function RankedRowSkeleton() {
  return (
    <div class="flex items-center gap-3 px-3 py-2">
      <div class={`h-3.5 w-6 shrink-0 rounded ${SKELETON_BAR_CLASS}`} />
      <div class={`h-10 w-10 shrink-0 rounded-md ${SKELETON_BAR_CLASS}`} />
      <div class="min-w-0 flex-1 space-y-2">
        <div class={`h-3.5 w-40 max-w-full rounded ${SKELETON_BAR_CLASS}`} />
        <div class={`h-3 w-24 max-w-full rounded ${SKELETON_BAR_CLASS}`} />
      </div>
      <div class={`h-8 w-14 shrink-0 rounded ${SKELETON_BAR_CLASS}`} />
    </div>
  );
}

function RecentRowSkeleton() {
  return (
    <div class="flex items-center gap-3 px-3 py-2">
      <div class={`h-9 w-9 shrink-0 rounded-md ${SKELETON_BAR_CLASS}`} />
      <div class="min-w-0 flex-1 space-y-2">
        <div class={`h-3.5 w-32 max-w-full rounded ${SKELETON_BAR_CLASS}`} />
        <div class={`h-3 w-20 max-w-full rounded ${SKELETON_BAR_CLASS}`} />
      </div>
      <div class={`h-3 w-10 shrink-0 rounded ${SKELETON_BAR_CLASS}`} />
    </div>
  );
}

interface RecentDayGroup {
  key: string;
  label: string;
  plays: MusicRecentPlay[];
}

export default function MusicOverview() {
  // Local UI state only — the range is a reading preference, not a shareable
  // address, so it deliberately stays out of the URL.
  const [kind, setKind] = createSignal<ListeningKind>("tracks");
  const [period, setPeriod] = createSignal<MusicPeriod>("4w");

  const rankingsQuery = useMusicRankings(period);
  const recentQuery = useMusicRecent();
  const playlistsQuery = useMusicPlaylists();
  const friendsQuery = useMusicFriendListens();

  const playlists = () =>
    playlistsQuery.isPending ? [] : playlistsQuery.data?.playlists ?? [];
  const friends = () => friendsQuery.isPending ? [] : friendsQuery.data?.friends ?? [];

  const rankings = () => (rankingsQuery.isPending ? undefined : rankingsQuery.data);

  // A range the user already opened comes back from cache immediately and
  // refetches in the background: dim that content rather than dropping the
  // whole section back to skeletons. The controls sit outside this region so
  // they stay usable throughout.
  const rankingsAreStale = () => rankingsQuery.isFetching && !rankingsQuery.isPending;
  const recentIsStale = () => recentQuery.isFetching && !recentQuery.isPending;

  // Ranked lists arrive ordered by plays, so the first entry sets the scale for
  // every row's share rule.
  const topPlayCount = () =>
    kind() === "artists"
      ? rankings()?.topArtists[0]?.playCount ?? 0
      : rankings()?.topTracks[0]?.playCount ?? 0;

  // Recent plays read as a diary: consecutive plays from the same calendar day
  // collapse under one day heading ("Today", "Yesterday", "4d ago", "Mar 5").
  const recentGroups = createMemo<RecentDayGroup[]>(() => {
    const groups: RecentDayGroup[] = [];
    for (const play of recentQuery.data?.recent ?? []) {
      const date = new Date(play.timestamp);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const current = groups.at(-1);
      if (current && current.key === key) {
        current.plays.push(play);
      } else {
        groups.push({
          key,
          label: formatRecentDay(play.timestamp),
          plays: [play],
        });
      }
    }
    return groups;
  });

  return (
    <div class="h-full overflow-y-auto">
      <div class="max-w-5xl mx-auto p-4 sm:p-6 space-y-8">
        <div>
          <h1 class="font-display text-2xl font-medium">Music</h1>
        </div>

        <section aria-labelledby="your-listening-heading" class="space-y-4">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-3">
            <h2
              id="your-listening-heading"
              class="text-xs font-medium text-muted-foreground uppercase tracking-wider"
            >
              Your listening
            </h2>
            <span class="hidden h-px flex-1 bg-border sm:block" />
            {/* Both groups scroll horizontally on narrow screens (bleeding to
                the page edge) instead of squashing their labels. */}
            <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <div class="-mx-4 overflow-x-auto px-4 py-0.5 scrollbar-hide sm:mx-0 sm:px-0">
                <SegmentedControl
                  label="Listening breakdown"
                  options={KIND_OPTIONS}
                  value={kind()}
                  onChange={(value) => setKind(value)}
                />
              </div>
              <div class="-mx-4 overflow-x-auto px-4 py-0.5 scrollbar-hide sm:mx-0 sm:px-0">
                <SegmentedControl
                  label="Time range"
                  options={PERIOD_OPTIONS}
                  value={period()}
                  onChange={(value) => setPeriod(value)}
                />
              </div>
            </div>
          </div>

          <Show when={rankingsQuery.isRefetchError}>
            <p class="text-sm text-red-500">
              Failed to refresh your listening history. Showing the last loaded range.
            </p>
          </Show>

          <div class="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.9fr)]">
            <div class="min-w-0 space-y-3">
              <h3 class="sr-only">
                {KIND_HEADINGS[kind()]} · {PERIOD_LABELS[period()]}
              </h3>

              <Switch>
                <Match when={rankingsQuery.isPending}>
                  <div class="rounded-xl bg-card overflow-hidden">
                    <div class="border-b border-border px-3 py-2.5">
                      <div class={`h-4 w-56 max-w-full rounded ${SKELETON_BAR_CLASS}`} />
                    </div>
                    <div class="divide-y divide-border">
                      <RankedRowSkeleton />
                      <RankedRowSkeleton />
                      <RankedRowSkeleton />
                      <RankedRowSkeleton />
                      <RankedRowSkeleton />
                    </div>
                  </div>
                </Match>

                <Match when={rankingsQuery.isLoadingError}>
                  <div class="p-4 rounded-lg bg-card text-sm text-red-500">
                    Failed to load your listening history.
                  </div>
                </Match>

                <Match when={rankings()}>
                  {(overview) => (
                    <div
                      class={`rounded-xl bg-card overflow-hidden ${staleContentClass(rankingsAreStale())}`}
                      aria-busy={rankingsAreStale()}
                    >
                      <ListeningStats overview={overview()} />

                      <Switch>
                        <Match when={overview().totalPlays === 0}>
                          <div class="space-y-2 px-4 py-6 text-sm text-muted-foreground">
                            <p class="font-medium text-foreground">
                              No Spotify listens in this range.
                            </p>
                            <Show
                              when={period() !== "all"}
                              fallback={
                                <p>
                                  Once the{" "}
                                  <code class="px-1 py-0.5 rounded bg-accent text-xs">spotify</code>{" "}
                                  sync imports your play history, top tracks and recent plays
                                  appear here.{" "}
                                  <A href="/sync/spotify" class="text-primary hover:underline">
                                    View the sync source →
                                  </A>
                                </p>
                              }
                            >
                              <p>Nothing was recorded {PERIOD_PHRASES[period()]}.</p>
                              <p>
                                <button
                                  type="button"
                                  class={TEXT_BUTTON_CLASS}
                                  onClick={() => setPeriod("all")}
                                >
                                  Show all time →
                                </button>
                              </p>
                            </Show>
                          </div>
                        </Match>

                        <Match when={kind() === "tracks"}>
                          <RankedListHeader label="Track" art />
                          <ol class="max-h-[30rem] divide-y divide-border overflow-y-auto">
                            <For
                              each={overview().topTracks}
                              fallback={
                                <li class="px-4 py-6 text-sm text-muted-foreground">
                                  No ranked tracks in this range yet.
                                </li>
                              }
                            >
                              {(track) => (
                                <RankedTrackRow
                                  track={track}
                                  share={shareOfTop(track.playCount, topPlayCount())}
                                />
                              )}
                            </For>
                          </ol>
                        </Match>

                        <Match when={kind() === "artists"}>
                          <RankedListHeader label="Artist" art={false} />
                          <ol class="max-h-[30rem] divide-y divide-border overflow-y-auto">
                            <For
                              each={overview().topArtists}
                              fallback={
                                <li class="px-4 py-6 text-sm text-muted-foreground">
                                  No ranked artists in this range yet.
                                </li>
                              }
                            >
                              {(artist) => (
                                <RankedArtistRow
                                  artist={artist}
                                  share={shareOfTop(artist.playCount, topPlayCount())}
                                />
                              )}
                            </For>
                          </ol>
                        </Match>
                      </Switch>
                    </div>
                  )}
                </Match>
              </Switch>
            </div>

            <div class="min-w-0 space-y-3">
              <div class="flex items-center gap-2">
                <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Recent plays
                </h3>
                <span class="h-px flex-1 bg-border" />
              </div>

              <Switch>
                <Match when={recentQuery.isPending}>
                  <div class="rounded-xl bg-card divide-y divide-border overflow-hidden">
                    <RecentRowSkeleton />
                    <RecentRowSkeleton />
                    <RecentRowSkeleton />
                    <RecentRowSkeleton />
                  </div>
                </Match>

                <Match when={recentQuery.isLoadingError}>
                  <div class="p-4 rounded-lg bg-card text-sm text-red-500">
                    Failed to load recent plays.
                  </div>
                </Match>

                <Match when={recentGroups().length === 0}>
                  <div class="p-6 rounded-lg bg-card text-sm text-muted-foreground">
                    No recent Spotify plays recorded.
                  </div>
                </Match>

                <Match when={recentGroups().length > 0}>
                  <div
                    class={`rounded-xl bg-card overflow-hidden ${staleContentClass(recentIsStale())}`}
                    aria-busy={recentIsStale()}
                  >
                    <div class="max-h-[30rem] overflow-y-auto">
                      <For each={recentGroups()}>
                        {(group, groupIndex) => (
                          <section>
                            <h4 class="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b border-border bg-card px-3 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                              <span>{group.label}</span>
                              <span class="font-mono normal-case tabular-nums">
                                {group.plays.length.toLocaleString()}
                                <span class="sr-only"> plays</span>
                              </span>
                            </h4>
                            <ol class="divide-y divide-border">
                              <For each={group.plays}>
                                {(play, index) => (
                                  <RecentPlayRow
                                    play={play}
                                    latest={groupIndex() === 0 && index() === 0}
                                  />
                                )}
                              </For>
                            </ol>
                          </section>
                        )}
                      </For>
                    </div>
                  </div>
                </Match>
              </Switch>
            </div>
          </div>
        </section>

        <div class="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.9fr)]">
          <section class="space-y-3 min-w-0">
            <div class="flex items-center justify-between gap-3">
              <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Tracked playlists
              </h2>
              <span class="h-px flex-1 bg-border" />
              <Show when={playlists().length > 0}>
                <div class="text-xs text-muted-foreground">
                  <span class="font-mono">{playlists().length.toLocaleString()}</span> tracked
                </div>
              </Show>
            </div>

            <Switch>
              <Match when={playlistsQuery.isPending}>
                <div class="rounded-xl bg-card divide-y divide-border overflow-hidden">
                  <RowSkeleton />
                  <RowSkeleton />
                  <RowSkeleton />
                </div>
              </Match>

              <Match when={playlistsQuery.isLoadingError}>
                <div class="p-4 rounded-lg bg-card text-sm text-red-500">
                  Failed to load playlists.
                </div>
              </Match>

              <Match when={playlists().length === 0}>
                <div class="p-6 rounded-lg bg-card text-sm text-muted-foreground space-y-2">
                  <p class="text-foreground font-medium">No playlists tracked yet.</p>
                  <p>
                    Add a{" "}
                    <code class="px-1 py-0.5 rounded bg-accent text-xs">[sync.spotify-playlists]</code>{" "}
                    section with a <code class="px-1 py-0.5 rounded bg-accent text-xs">playlists</code>{" "}
                    list to your config, then let the sync run (or seed history with{" "}
                    <code class="px-1 py-0.5 rounded bg-accent text-xs">seed-playlist-follows.ts</code>).
                  </p>
                  <p>
                    <A href="/sync/spotify-playlists" class="text-primary hover:underline">
                      View the sync source →
                    </A>
                  </p>
                </div>
              </Match>

              <Match when={playlists().length > 0}>
                <div class="rounded-xl bg-card divide-y divide-border overflow-y-auto max-h-[28rem]">
                  <For each={playlists()}>
                    {(playlist) => <PlaylistRow playlist={playlist} />}
                  </For>
                </div>
              </Match>
            </Switch>
          </section>

          <section class="space-y-3 min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Friends listening
              </h2>
              <span class="h-px flex-1 bg-border" />
            </div>

            <Switch>
              <Match when={friendsQuery.isPending}>
                <div class="rounded-xl bg-card divide-y divide-border overflow-hidden">
                  <FriendListenSkeleton />
                  <FriendListenSkeleton />
                  <FriendListenSkeleton />
                </div>
              </Match>

              <Match when={friendsQuery.isLoadingError}>
                <div class="p-4 rounded-lg bg-card text-sm text-red-500">
                  Failed to load friend listens.
                </div>
              </Match>

              <Match when={friends().length === 0}>
                <div class="p-6 rounded-lg bg-card text-sm text-muted-foreground space-y-2">
                  <p class="text-foreground font-medium">No friend listens yet.</p>
                  <p>Run the Spotify Friends sync to show what friends last listened to.</p>
                </div>
              </Match>

              <Match when={friends().length > 0}>
                <div class="rounded-xl bg-card divide-y divide-border overflow-y-auto max-h-[28rem]">
                  <For each={friends()}>
                    {(friend) => <FriendListenRow friend={friend} />}
                  </For>
                </div>
              </Match>
            </Switch>
          </section>
        </div>
      </div>
    </div>
  );
}
