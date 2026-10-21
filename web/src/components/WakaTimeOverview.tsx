import { useNavigate, useSearchParams } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import type { EChartsOption } from "echarts";
import { EChartsAutoSize } from "../ui/echarts";
import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js";
import {
  type WakaTimePreset,
} from "../lib/api";
import { useChartTheme } from "../lib/echarts-theme";
import { formatDuration } from "../lib/format";
import { useCodingProjects, useCodingStats } from "../lib/queries";
import { normalizeRouteParam } from "../lib/route-params";
import { getSourceColorStyle } from "../lib/source-styles";
import SegmentedControl from "../ui/SegmentedControl";

// Format short duration (for stats)
function formatShortDuration(ms: number): string {
  const hours = ms / 3600000;
  if (hours >= 1) {
    return `${hours.toFixed(1)}h`;
  }
  return `${Math.round(ms / 60000)}m`;
}

// Format date for display
function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const PRESETS: { value: WakaTimePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "year", label: "Last Year" },
  { value: "all", label: "All Time" },
];

const validPresets = new Set<WakaTimePreset>(["today", "yesterday", "7d", "30d", "year", "all"]);

export default function WakaTimeOverview() {
  const chart = useChartTheme();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get initial preset from URL, default to "7d"
  const initialPreset = (): WakaTimePreset => {
    const p = normalizeRouteParam(searchParams.preset);
    return validPresets.has(p as WakaTimePreset) ? (p as WakaTimePreset) : "7d";
  };

  const [preset, setPresetInternal] = createSignal<WakaTimePreset>(initialPreset());
  const [searchQuery, setSearchQuery] = createSignal("");
  const statsQuery = useCodingStats(preset);
  const projectsQuery = useCodingProjects(() => ({ limit: 200 }));

  const stats = () =>
    statsQuery.isPending || statsQuery.isLoadingError ? null : statsQuery.data ?? null;
  const projects = () =>
    projectsQuery.isPending || projectsQuery.isLoadingError
      ? []
      : projectsQuery.data?.projects ?? [];

  // Wrapper to sync preset changes to URL
  const setPreset = (p: WakaTimePreset) => {
    setPresetInternal(p);
    setSearchParams({ preset: p === "7d" ? undefined : p }, { replace: true });
  };

  // Sync URL back to preset (for browser back/forward)
  createEffect(on(() => searchParams.preset, (urlPreset) => {
    const normalized = normalizeRouteParam(urlPreset);
    const p = validPresets.has(normalized as WakaTimePreset)
      ? (normalized as WakaTimePreset)
      : "7d";
    if (p !== preset()) {
      setPresetInternal(p);
    }
  }));

  const openProject = (projectName: string) => {
    navigate(`/coding/project/${encodeURIComponent(projectName)}`);
  };

  // Filter projects by search
  const filteredProjects = () => {
    const query = searchQuery().toLowerCase();
    if (!query) return projects();
    return projects().filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.primaryLanguage?.toLowerCase().includes(query)
    );
  };

  // Build bar chart option for projects
  const projectsChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.byProject.length === 0) return null;

    const top10 = s.byProject.slice(0, 10);
    return {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params: unknown) => {
          const p = (params as { name: string; value: number }[])[0];
          return `${p.name}: ${formatDuration(p.value)}`;
        },
      },
      grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
      xAxis: {
        type: "category",
        data: top10.map((p) => p.name),
        axisLabel: {
          rotate: 30,
          interval: 0,
          formatter: (value: string) =>
            value.length > 12 ? value.slice(0, 12) + "..." : value,
        },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          formatter: (value: number) => formatShortDuration(value),
        },
      },
      series: [
        {
          type: "bar",
          data: top10.map((p) => p.duration),
          itemStyle: { color: chart.palette()[0] },
        },
      ],
    };
  };

  // Build pie chart option for languages
  const languagesChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.byLanguage.length === 0) return null;

    const top8 = s.byLanguage.slice(0, 8);
    return {
      tooltip: {
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { name: string; value: number; percent: number };
          return `${p.name}: ${formatDuration(p.value)} (${p.percent.toFixed(1)}%)`;
        },
      },
      series: [
        {
          type: "pie",
          radius: ["40%", "70%"],
          data: top8.map((l) => ({ name: l.name, value: l.duration })),
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: "rgba(0, 0, 0, 0.5)",
            },
          },
          label: {
            formatter: "{b}: {d}%",
          },
        },
      ],
    };
  };

  // Build activity line chart
  const activityChartOption = (): EChartsOption | null => {
    const s = stats();
    if (!s || s.byDay.length === 0) return null;

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const p = (params as { axisValue: string; value: number }[])[0];
          return `${p.axisValue}: ${formatDuration(p.value)}`;
        },
      },
      grid: { left: "3%", right: "4%", bottom: "3%", containLabel: true },
      xAxis: {
        type: "category",
        data: s.byDay.map((d) => d.date),
        axisLabel: {
          formatter: (value: string) => {
            const date = new Date(value);
            return `${date.getMonth() + 1}/${date.getDate()}`;
          },
          interval: Math.floor(s.byDay.length / 10),
        },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          formatter: (value: number) => formatShortDuration(value),
        },
      },
      series: [
        {
          type: "line",
          data: s.byDay.map((d) => d.duration),
          smooth: true,
          areaStyle: { opacity: 0.3 },
          itemStyle: { color: chart.palette()[0] },
        },
      ],
    };
  };

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <div class="flex items-center justify-between mb-6">
          <h1 class="font-display text-2xl font-medium">Coding Activity</h1>
          <SegmentedControl options={PRESETS} value={preset()} onChange={setPreset} />
        </div>

        <Show when={statsQuery.isRefetchError}>
          <div class="text-center mb-4 text-sm text-red-500">
            Failed to refresh coding activity. Showing cached data for this period.
          </div>
        </Show>
        <Switch>
          <Match when={statsQuery.isPending}>
            <div class="text-center py-12 text-muted-foreground">Loading coding activity...</div>
          </Match>
          <Match when={statsQuery.isLoadingError}>
            <div class="text-center py-12 text-red-500">
              Failed to load coding activity for this period.
            </div>
          </Match>
          <Match when={stats()}>
            {(s) => (
              <>
              {/* Stats Cards */}
              <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div class="rounded-lg bg-card p-4">
                  <div class="text-3xl font-bold font-mono text-purple-400">
                    {formatDuration(s().totalDuration)}
                  </div>
                  <div class="text-sm text-muted-foreground">Total Coding Time</div>
                </div>
                <div class="rounded-lg bg-card p-4">
                  <div class="text-3xl font-bold font-mono">{s().sessionCount}</div>
                  <div class="text-sm text-muted-foreground">Sessions</div>
                </div>
                <div class="rounded-lg bg-card p-4">
                  <div class="text-3xl font-bold font-mono">
                    {formatDuration(s().avgSessionDuration)}
                  </div>
                  <div class="text-sm text-muted-foreground">Avg Session</div>
                </div>
                <div class="rounded-lg bg-card p-4">
                  <div class="text-lg font-medium font-mono">{s().byProject.length}</div>
                  <div class="text-sm text-muted-foreground">Projects</div>
                  <Show when={s().dateRange.start && s().dateRange.end}>
                    <div class="text-xs text-muted-foreground mt-1 font-mono">
                      {formatDate(s().dateRange.start)} - {formatDate(s().dateRange.end)}
                    </div>
                  </Show>
                </div>
              </div>

              {/* Charts Row */}
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                {/* Projects Bar Chart */}
                <div class="rounded-lg bg-card p-4">
                  <h3 class="text-sm font-medium text-muted-foreground mb-2">
                    Top Projects
                  </h3>
                  <Show
                    when={projectsChartOption()}
                    fallback={
                      <div class="h-64 flex items-center justify-center text-muted-foreground">
                        No project data
                      </div>
                    }
                  >
                    {(opt) => (
                      <div class="h-64">
                        <EChartsAutoSize option={chart.option(opt())} />
                      </div>
                    )}
                  </Show>
                </div>

                {/* Languages Pie Chart */}
                <div class="rounded-lg bg-card p-4">
                  <h3 class="text-sm font-medium text-muted-foreground mb-2">
                    Languages
                  </h3>
                  <Show
                    when={languagesChartOption()}
                    fallback={
                      <div class="h-64 flex items-center justify-center text-muted-foreground">
                        No language data
                      </div>
                    }
                  >
                    {(opt) => (
                      <div class="h-64">
                        <EChartsAutoSize option={chart.option(opt())} />
                      </div>
                    )}
                  </Show>
                </div>
              </div>

              {/* Activity Chart */}
              <div class="rounded-lg bg-card p-4 mb-6">
                <h3 class="text-sm font-medium text-muted-foreground mb-2">
                  Daily Activity
                </h3>
                <Show
                  when={activityChartOption()}
                  fallback={
                    <div class="h-48 flex items-center justify-center text-muted-foreground">
                      No activity data
                    </div>
                  }
                >
                  {(opt) => (
                    <div class="h-48">
                      <EChartsAutoSize option={chart.option(opt())} />
                    </div>
                  )}
                </Show>
              </div>

              </>
            )}
          </Match>
        </Switch>

        {/* Projects List */}
        <div class="rounded-lg bg-card">
                <div class="p-4 border-b border-border flex items-center justify-between gap-3">
                  <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">All Projects</h3>
                  <span class="h-px flex-1 bg-border" />
                  <input
                    type="text"
                    placeholder="Search projects..."
                    class="px-3 py-1.5 text-sm bg-background border border-border rounded-md w-64"
                    value={searchQuery()}
                    onInput={(e) => setSearchQuery(e.currentTarget.value)}
                  />
                </div>
                <div class="divide-y divide-border max-h-96 overflow-auto">
                  <Show when={projectsQuery.isRefetchError}>
                    <div class="p-4 text-center text-sm text-red-500">
                      Failed to refresh coding projects. Showing cached data.
                    </div>
                  </Show>
                  <Switch>
                    <Match when={projectsQuery.isPending}>
                      <div class="p-4 text-center text-muted-foreground">Loading projects...</div>
                    </Match>
                    <Match when={projectsQuery.isLoadingError}>
                      <div class="p-4 text-center text-red-500">
                        Failed to load coding projects.
                      </div>
                    </Match>
                    <Match when={filteredProjects().length === 0}>
                      <div class="p-4 text-center text-muted-foreground">No projects found</div>
                    </Match>
                    <Match when={filteredProjects().length > 0}>
                    <For each={filteredProjects()}>
                      {(project) => (
                        <button
                          class="w-full p-4 text-left hover:bg-accent transition-colors flex items-center justify-between"
                          onClick={() => openProject(project.name)}
                        >
                          <div class="min-w-0">
                            <div class="font-medium">{project.name}</div>
                            <div class="text-sm text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                              <Show when={project.primaryLanguage}>
                                <span class="px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">
                                  {project.primaryLanguage}
                                </span>
                              </Show>
                              <For each={project.aiSources}>
                                {(source) => (
                                  <span
                                    class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium source-badge"
                                    style={getSourceColorStyle(source)}
                                  >
                                    {sourceLabel(source)}
                                  </span>
                                )}
                              </For>
                              <span class="font-mono">
                                {formatDate(project.firstActivity)} -{" "}
                                {formatDate(project.lastActivity)}
                              </span>
                            </div>
                          </div>
                          <div class="text-right shrink-0 ml-3">
                            <Show
                              when={project.totalDuration > 0}
                              fallback={
                                <div class="font-bold font-mono text-muted-foreground">—</div>
                              }
                            >
                              <div class="font-bold font-mono text-purple-400">
                                {formatDuration(project.totalDuration)}
                              </div>
                            </Show>
                            <div class="text-sm text-muted-foreground">
                              <Show
                                when={project.sessionCount > 0}
                                fallback={
                                  <Show
                                    when={project.conversationCount > 0}
                                    fallback={<span>no activity</span>}
                                  >
                                    <span>
                                      {project.conversationCount}{" "}
                                      {project.conversationCount === 1 ? "convo" : "convos"}
                                    </span>
                                  </Show>
                                }
                              >
                                <span>
                                  {project.sessionCount} sessions
                                  <Show when={project.conversationCount > 0}>
                                    <span class="text-muted-foreground/70">
                                      {" "}
                                      · {project.conversationCount}{" "}
                                      {project.conversationCount === 1 ? "convo" : "convos"}
                                    </span>
                                  </Show>
                                </span>
                              </Show>
                            </div>
                          </div>
                        </button>
                      )}
                    </For>
                    </Match>
                  </Switch>
                </div>
              </div>
      </div>
    </div>
  );
}
