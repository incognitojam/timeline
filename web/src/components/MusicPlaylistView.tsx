import { A, useParams } from "@solidjs/router";
import type { EChartsOption } from "echarts";
import { EChartsAutoSize } from "../ui/echarts";
import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { PlaylistObservationPoint } from "../lib/api";
import { useChartTheme } from "../lib/echarts-theme";
import { avgPerYear, creationAnchor, pastYearSaves } from "../lib/playlist-stats";
import { useMusicPlaylist } from "../lib/queries";
import { IconHistory, IconOpenInNew } from "../ui/icons";
import PlaylistArt from "./PlaylistArt";

function formatDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * A summary card for a signed delta; renders "—" when the value is unknown.
 * `estimated` marks a figure inferred from the creation anchor (rather than
 * measured from real readings) with a "~" prefix and an explanatory tooltip.
 */
function DeltaCard(props: { label: string; value: number | null; estimated?: boolean }) {
  const known = () => props.value !== null;
  const v = () => props.value ?? 0;
  return (
    <div
      class="p-3 rounded-lg bg-card"
      title={
        props.estimated && known()
          ? "Rough estimate from the playlist's creation date (assumes it started empty)"
          : undefined
      }
    >
      <div class="text-xs text-muted-foreground">{props.label}</div>
      <div
        class="text-xl font-semibold font-mono tabular-nums"
        classList={{
          "text-green-500": known() && v() > 0,
          "text-red-500": known() && v() < 0,
          "text-muted-foreground": !known(),
        }}
      >
        <Show when={known()} fallback="—">
          {props.estimated ? "~" : ""}
          {v() > 0 ? "+" : ""}
          {v().toLocaleString()}
        </Show>
      </div>
    </div>
  );
}

interface TableRow extends PlaylistObservationPoint {
  delta: number;
}

// Marks observations backfilled from manual history (origin = 'seed') rather
// than recorded by a live API sync. Live rows show nothing (the default).
function SeedMark() {
  return (
    <span title="Backfilled from manual history">
      <IconHistory
        class="inline-block text-muted-foreground w-3.5 h-3.5"
        role="img"
        aria-label="Backfilled from manual history"
      />
    </span>
  );
}

export default function MusicPlaylistView() {
  const chart = useChartTheme();
  const params = useParams();
  const playlistQuery = useMusicPlaylist(() => params.id);
  const playlist = () => playlistQuery.isPending ? undefined : playlistQuery.data;

  const observations = () => playlist()?.observations ?? [];

  const title = () => playlist()?.name ?? params.id;

  const imageUrl = () => playlist()?.imageUrl ?? null;

  const latest = () => observations().at(-1)?.count ?? 0;

  // Artificial 0-saves point at the creation date, when known and before the
  // first reading. Drives the chart's dashed lead-in and the creation-anchored
  // estimates below. null leaves both falling back to the real observations.
  const anchor = () => creationAnchor(playlist()?.createdDate, observations());

  // Saves gained over the trailing 12 months: the real measured change when
  // there are enough readings, otherwise a rough estimate from the creation
  // anchor (see pastYearSaves). null when neither is possible.
  const pastYear = () => pastYearSaves(observations(), playlist()?.createdDate);

  // Average annual growth. Anchored at the creation date (0 saves) when known,
  // giving a lifetime saves-per-year estimate; otherwise annualizes across the
  // observed span. estimated whenever the artificial anchor was used.
  const perYear = (): number | null => {
    const a = anchor();
    return avgPerYear(a ? [a, ...observations()] : observations());
  };
  const perYearEstimated = (): boolean => anchor() !== null && perYear() !== null;

  // Newest-first rows with per-reading delta.
  const tableRows = createMemo<TableRow[]>(() => {
    const obs = observations();
    const rows: TableRow[] = obs.map((o, i) => ({
      ...o,
      delta: i === 0 ? 0 : o.count - obs[i - 1].count,
    }));
    return rows.reverse();
  });

  const chartOption = (): EChartsOption | null => {
    const obs = observations();
    if (obs.length === 0) return null;
    const series: NonNullable<EChartsOption["series"]> = [
      {
        type: "line",
        name: "Saves",
        data: obs.map((o) => [o.date, o.count] as [string, number]),
        smooth: true,
        showSymbol: obs.length < 60,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.12 },
      },
    ];
    // Dashed lead-in from the artificial 0-saves anchor to the first real
    // reading: shows growth from creation as inferred, not observed. Same green
    // but faded + dashed so it reads as an estimate, no area fill.
    const a = anchor();
    if (a) {
      series.push({
        type: "line",
        name: "Estimated start",
        data: [
          [a.date, a.count],
          [obs[0].date, obs[0].count],
        ] as [string, number][],
        showSymbol: true,
        symbolSize: 5,
        lineStyle: { width: 2, type: "dashed", color: chart.palette()[1], opacity: 0.7 },
        itemStyle: { color: chart.palette()[1] },
      });
    }
    return {
      title: {
        text: "Saves",
        left: 0,
        top: 0,
        textStyle: { fontSize: 13, fontWeight: 500 },
      },
      grid: { top: 40, right: 16, bottom: 28, left: 44 },
      tooltip: { trigger: "axis" },
      color: [chart.palette()[1]],
      // Time axis so irregularly-spaced readings sit at their true dates
      // (samples are sparse early on, denser recently).
      xAxis: { type: "time" },
      yAxis: { type: "value", minInterval: 1 },
      series,
    };
  };

  return (
    <div class="h-full overflow-y-auto">
      <div class="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
        <div class="flex items-start justify-between gap-4">
          <div class="flex items-start gap-3 min-w-0">
            <PlaylistArt src={imageUrl()} name={playlist()?.name} class="h-16 w-16 shrink-0" />
            <div class="min-w-0">
              <A href="/music" class="text-xs text-muted-foreground hover:text-foreground">
                ← Music
              </A>
              <h1 class="font-display text-2xl font-medium break-words mt-1">{title()}</h1>
            </div>
          </div>
          <a
            href={`https://open.spotify.com/playlist/${params.id}`}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 text-sm text-primary hover:underline shrink-0 mt-1"
          >
            Open in Spotify
            <IconOpenInNew class="h-4 w-4" aria-hidden />
          </a>
        </div>

        <Switch>
          <Match when={playlistQuery.isPending}>
            <div class="h-64 rounded-lg bg-card animate-pulse" />
          </Match>

          <Match when={playlistQuery.isLoadingError}>
            <div class="p-4 rounded-lg bg-card text-sm text-red-500">
              Failed to load playlist history.
            </div>
          </Match>

          <Match when={observations().length === 0}>
            <div class="p-6 rounded-lg bg-card text-sm text-muted-foreground">
              No saved-count history yet for this playlist. Once the{" "}
              <code class="px-1 py-0.5 rounded bg-accent text-xs">spotify-playlists</code> sync
              runs (or you seed history), the trend will appear here.
            </div>
          </Match>

          <Match when={observations().length > 0}>
            <div class="grid grid-cols-3 gap-3">
              <div class="p-3 rounded-lg bg-card">
                <div class="text-xs text-muted-foreground">Current saves</div>
                <div class="text-xl font-semibold font-mono tabular-nums">
                  {latest().toLocaleString()}
                </div>
              </div>
              <DeltaCard
                label="Past 12 months"
                value={pastYear()?.value ?? null}
                estimated={pastYear()?.estimated ?? false}
              />
              <DeltaCard label="Avg / year" value={perYear()} estimated={perYearEstimated()} />
            </div>

            <Show when={chartOption()}>
              {(opt) => (
                <div class="space-y-1">
                  <div class="h-64 rounded-lg bg-card p-2">
                    <EChartsAutoSize option={chart.option(opt())} />
                  </div>
                  <Show when={anchor()}>
                    <p class="text-xs text-muted-foreground">
                      Dashed line: estimated growth from the playlist's creation date (no saves
                      are recorded before tracking began).
                    </p>
                  </Show>
                </div>
              )}
            </Show>

            <div class="rounded-lg border border-border max-h-80 overflow-y-auto">
              <table class="w-full text-sm">
                <thead class="sticky top-0 z-10 bg-card text-muted-foreground">
                  <tr class="border-b border-border">
                    <th class="text-left font-medium px-4 py-2">Date</th>
                    <th class="text-right font-medium px-4 py-2">Saves</th>
                    <th class="text-right font-medium px-4 py-2">Change</th>
                    <th class="px-4 py-2 w-10">
                      <span class="sr-only">Origin</span>
                    </th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border">
                  <For each={tableRows()}>
                    {(row) => (
                      <tr>
                        <td class="px-4 py-2 font-mono">{formatDate(row.date)}</td>
                        <td class="px-4 py-2 text-right font-mono tabular-nums">
                          {row.count.toLocaleString()}
                        </td>
                        <td
                          class="px-4 py-2 text-right font-mono tabular-nums"
                          classList={{
                            "text-green-500": row.delta > 0,
                            "text-red-500": row.delta < 0,
                            "text-muted-foreground": row.delta === 0,
                          }}
                        >
                          {row.delta > 0 ? "+" : ""}
                          {row.delta}
                        </td>
                        <td class="px-4 py-2 text-right">
                          <Show when={row.origin === "seed"}>
                            <SeedMark />
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  );
}
