import { useNavigate, useParams } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import type { EChartsOption } from "echarts";
import { EChartsAutoSize } from "../ui/echarts";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { CodingProjectConversation } from "../lib/api";
import { useChartTheme } from "../lib/echarts-theme";
import { formatDateSeparator, formatDuration, formatTime } from "../lib/format";
import {
  useCodingProject,
  useCodingProjectConversations,
  useCodingProjectSessions,
} from "../lib/queries";
import { buildConversationUrl, buildTimelineUrl } from "../lib/routes";
import { getSourceColorStyle } from "../lib/source-styles";
import type { TimelineEvent } from "../lib/types";
import { useScrollToAnchor } from "../lib/useScrollToAnchor";
import { IconBarChart, IconChevronLeft } from "../ui/icons";

function formatShortDuration(ms: number): string {
  const hours = ms / 3600000;
  if (hours >= 1) {
    return `${hours.toFixed(1)}h`;
  }
  return `${Math.round(ms / 60000)}m`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function groupByDate(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const date = event.timestamp ? formatDateSeparator(event.timestamp) : "Unknown Date";
    let group = groups.get(date);
    if (!group) {
      group = [];
      groups.set(date, group);
    }
    group.push(event);
  }
  return groups;
}

function groupConversationsByDate(
  convos: CodingProjectConversation[]
): Map<string, CodingProjectConversation[]> {
  const groups = new Map<string, CodingProjectConversation[]>();
  for (const c of convos) {
    const date = c.lastMessage ? formatDateSeparator(c.lastMessage) : "Unknown Date";
    let group = groups.get(date);
    if (!group) {
      group = [];
      groups.set(date, group);
    }
    group.push(c);
  }
  return groups;
}

// Strip the project prefix from a conversation title so the project page list
// reads as session titles, not "project: session". Handles:
//   "project: rest"           -> "rest"
//   "project / workspace: rest" -> "rest (workspace)"
//   "project (slug)"          -> "slug"
function displayConversationTitle(title: string, projectName: string): string {
  if (!projectName) return title;
  // "project / workspace: rest"
  if (title.startsWith(`${projectName} / `)) {
    const colonIdx = title.indexOf(": ", projectName.length);
    if (colonIdx > 0) {
      const workspace = title.slice(projectName.length + 3, colonIdx);
      const rest = title.slice(colonIdx + 2);
      return `${rest} (${workspace})`;
    }
  }
  // "project: rest"
  if (title.startsWith(`${projectName}: `)) {
    return title.slice(projectName.length + 2);
  }
  // "project (slug)"
  if (title.startsWith(`${projectName} (`) && title.endsWith(")")) {
    return title.slice(projectName.length + 2, -1);
  }
  return title;
}

interface SessionDetails {
  languages: Record<string, number>;
  branches: string[];
  fileCount: number;
  heartbeatCount: number;
}

function getSessionDetails(event: TimelineEvent): SessionDetails | null {
  if (!event.raw_data) return null;
  try {
    const raw = JSON.parse(event.raw_data);
    return {
      languages: raw.languages || {},
      branches: raw.branches || [],
      fileCount: raw.file_count || 0,
      heartbeatCount: raw.heartbeat_count || 0,
    };
  } catch {
    return null;
  }
}

function Sparkline(props: { data: number[]; width?: number; height?: number }) {
  const width = props.width ?? 120;
  const height = props.height ?? 24;

  const max = Math.max(...props.data, 1);
  const points = props.data
    .map((v, i) => {
      const x = (i / (props.data.length - 1 || 1)) * width;
      const y = height - (v / max) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} class="text-purple-400">
      <polyline fill="none" stroke="currentColor" stroke-width="1.5" points={points} />
    </svg>
  );
}

function SessionsSkeleton() {
  return (
    <div>
      <div class="sticky top-0 z-10 px-4 py-2 bg-background/95 backdrop-blur border-b border-border">
        <div class="h-4 w-32 bg-accent rounded animate-pulse" />
      </div>
      <div class="divide-y divide-border/50">
        <For each={[1, 2, 3, 4]}>
          {() => (
            <div class="p-4">
              <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0 space-y-2">
                  <div class="h-4 w-32 bg-accent rounded animate-pulse" />
                  <div class="flex gap-2">
                    <div class="h-5 w-16 bg-accent rounded animate-pulse" />
                    <div class="h-5 w-12 bg-accent rounded animate-pulse" />
                  </div>
                  <div class="h-3 w-40 bg-accent rounded animate-pulse" />
                </div>
                <div class="h-5 w-16 bg-accent rounded animate-pulse" />
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function ConversationsSkeleton() {
  return (
    <div>
      <div class="sticky top-0 z-10 px-4 py-2 bg-background/95 backdrop-blur border-b border-border">
        <div class="h-4 w-32 bg-accent rounded animate-pulse" />
      </div>
      <div class="divide-y divide-border/50">
        <For each={[1, 2, 3]}>
          {() => (
            <div class="p-4">
              <div class="flex items-start justify-between gap-4">
                <div class="flex-1 min-w-0 space-y-2">
                  <div class="flex gap-2">
                    <div class="h-5 w-16 bg-accent rounded animate-pulse" />
                    <div class="h-4 w-12 bg-accent rounded animate-pulse" />
                  </div>
                  <div class="h-4 w-48 bg-accent rounded animate-pulse" />
                </div>
                <div class="h-4 w-12 bg-accent rounded animate-pulse" />
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function SidebarSkeleton() {
  return (
    <>
      <div>
        <h3 class="text-sm font-medium text-muted-foreground mb-3">Overview</h3>
        <div class="space-y-2 text-sm">
          <For each={["Total Time", "Sessions", "First Activity", "Last Activity"]}>
            {(label) => (
              <div class="flex justify-between">
                <span class="text-muted-foreground">{label}</span>
                <div class="h-4 w-16 bg-accent rounded animate-pulse" />
              </div>
            )}
          </For>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-medium text-muted-foreground mb-3">Activity</h3>
        <div class="h-16 w-full bg-accent rounded animate-pulse" />
      </div>
      <div>
        <h3 class="text-sm font-medium text-muted-foreground mb-3">Languages</h3>
        <div class="space-y-2">
          <For each={[1, 2, 3]}>
            {() => (
              <div class="flex justify-between">
                <div class="h-4 w-20 bg-accent rounded animate-pulse" />
                <div class="h-4 w-12 bg-accent rounded animate-pulse" />
              </div>
            )}
          </For>
        </div>
      </div>
    </>
  );
}

export default function WakaTimeProjectView() {
  const chart = useChartTheme();
  const params = useParams();
  const navigate = useNavigate();
  const highlightEventId = useScrollToAnchor();

  const projectName = () => decodeURIComponent(params.name || "");

  const goBack = () => navigate("/coding");
  const openDay = (date: string, eventId?: number) => {
    navigate(buildTimelineUrl({ date, eventId }));
  };

  const statsQuery = useCodingProject(projectName);
  const sessionsQuery = useCodingProjectSessions(projectName);
  const conversationsQuery = useCodingProjectConversations(projectName);

  const [sidebarOpen, setSidebarOpen] = createSignal(true);

  const projectStats = () => statsQuery.isPending ? null : statsQuery.data ?? null;
  const totalCount = () => {
    if (sessionsQuery.isPending) return null;
    return sessionsQuery.data?.pages.at(-1)?.count ?? 0;
  };
  const conversationsTotal = () => {
    if (conversationsQuery.isPending) return null;
    return conversationsQuery.data?.pages.at(-1)?.total ?? 0;
  };
  const sessions = createMemo<TimelineEvent[] | null>(() => {
    if (sessionsQuery.isPending || sessionsQuery.isLoadingError) return null;
    return sessionsQuery.data?.pages.flatMap((page) => page.sessions) ?? [];
  });
  const conversations = createMemo<CodingProjectConversation[] | null>(() => {
    if (conversationsQuery.isPending || conversationsQuery.isLoadingError) return null;
    return conversationsQuery.data?.pages.flatMap((page) => page.conversations) ?? [];
  });

  // Tab choice is derived: the user's explicit pick wins, otherwise we default
  // to "sessions" as soon as we know the project has any. We only need to wait
  // for the conversations count when sessions is empty — that's when we'd
  // auto-switch to Conversations to avoid flashing "No sessions found" for an
  // AI-only project.
  type ProjectTab = "sessions" | "conversations";
  const [userTab, setUserTab] = createSignal<{
    project: string;
    value: ProjectTab;
  } | null>(null);
  const tab = (): "sessions" | "conversations" | null => {
    const picked = userTab();
    if (picked?.project === projectName()) return picked.value;
    if (sessionsQuery.isPending) return null;
    if ((totalCount() ?? 0) > 0) return "sessions";
    if (conversationsQuery.isPending) return null;
    return (conversationsTotal() ?? 0) > 0 ? "conversations" : "sessions";
  };
  const setTab = (value: ProjectTab) => {
    setUserTab({ project: projectName(), value });
  };
  const loadMoreSessions = () => {
    if (!sessionsQuery.hasNextPage || sessionsQuery.isFetching) return;
    void sessionsQuery.fetchNextPage();
  };
  const loadMoreConversations = () => {
    if (!conversationsQuery.hasNextPage || conversationsQuery.isFetching) return;
    void conversationsQuery.fetchNextPage();
  };

  // "Not found" / network failure: only fires once every fetch has settled
  // and produced nothing usable. A transport error wins over the 404 wording
  // so the user knows the data failed to load rather than the project being
  // absent.
  const error = (): string | null => {
    if (
      statsQuery.isPending ||
      sessionsQuery.isPending ||
      conversationsQuery.isPending
    ) {
      return null;
    }
    const hasStats = projectStats() !== null;
    const hasSessions = (totalCount() ?? 0) > 0;
    const hasConvos = (conversationsTotal() ?? 0) > 0;
    if (hasStats || hasSessions || hasConvos) return null;
    return statsQuery.isLoadingError ||
      sessionsQuery.isLoadingError ||
      conversationsQuery.isLoadingError
      ? "Failed to load project data"
      : "Project not found";
  };

  const activityChartOption = (): EChartsOption | null => {
    const stats = projectStats();
    if (!stats || stats.byDay.length === 0) return null;

    return {
      tooltip: {
        trigger: "axis",
        formatter: (params: unknown) => {
          const p = (params as { axisValue: string; value: number }[])[0];
          return `${p.axisValue}: ${formatDuration(p.value)}`;
        },
      },
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: {
        type: "category",
        data: stats.byDay.map((d) => d.date),
        show: false,
      },
      yAxis: { type: "value", show: false },
      series: [
        {
          type: "line",
          data: stats.byDay.map((d) => d.duration),
          smooth: true,
          areaStyle: { opacity: 0.3 },
          itemStyle: { color: chart.palette()[0] },
          showSymbol: false,
        },
      ],
    };
  };

  return (
    <div class="h-full flex flex-col">
      <div class="flex items-center gap-4 p-4 border-b border-border bg-card/50">
        <button
          class="p-2 hover:bg-accent rounded-md transition-colors"
          onClick={goBack}
          title="Back to overview"
        >
          <IconChevronLeft class="w-5 h-5" />
        </button>
        <div class="flex-1 min-w-0">
          <h1 class="font-display text-xl font-medium truncate">{projectName()}</h1>
          <Show
            when={!statsQuery.isPending && !conversationsQuery.isPending}
            fallback={
              <div class="flex items-center gap-2 text-sm text-muted-foreground">
                <div class="h-4 w-16 bg-accent rounded animate-pulse" />
                <span>across</span>
                <div class="h-4 w-10 bg-accent rounded animate-pulse" />
                <span>sessions</span>
              </div>
            }
          >
            <div class="text-sm text-muted-foreground">
              <Show
                when={projectStats()}
                fallback={
                  <Show
                    when={(conversationsTotal() ?? 0) > 0}
                    fallback={<span>no activity</span>}
                  >
                    <span>
                      <span class="font-mono">{conversationsTotal()}</span>{" "}
                      {conversationsTotal() === 1 ? "conversation" : "conversations"}
                    </span>
                  </Show>
                }
              >
                {(stats) => (
                  <span>
                    <span class="font-mono">
                      {formatDuration(stats().project.totalDuration)}
                    </span>{" "}
                    across <span class="font-mono">{stats().project.sessionCount}</span> sessions
                    <Show when={(conversationsTotal() ?? 0) > 0}>
                      <span>
                        {" "}
                        · <span class="font-mono">{conversationsTotal()}</span>{" "}
                        {conversationsTotal() === 1 ? "conversation" : "conversations"}
                      </span>
                    </Show>
                  </span>
                )}
              </Show>
            </div>
          </Show>
        </div>
        <button
          class="p-2 hover:bg-accent rounded-md transition-colors"
          onClick={() => setSidebarOpen(!sidebarOpen())}
          title={sidebarOpen() ? "Hide stats" : "Show stats"}
        >
          <IconBarChart class="w-5 h-5" />
        </button>
      </div>

      <Show when={error()}>
        <div class="flex-1 flex items-center justify-center">
          <div class="text-destructive">{error()}</div>
        </div>
      </Show>

      <Show when={!error()}>
        <div class="flex-1 flex min-h-0">
          <div class="flex-1 flex flex-col min-w-0">
            <div class="flex border-b border-border bg-card/30">
              <button
                class={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                  tab() === "sessions"
                    ? "border-purple-400 text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setTab("sessions")}
              >
                Sessions
                <Show
                  when={totalCount() !== null}
                  fallback={
                    <span class="ml-1.5 inline-block h-3 w-6 bg-accent rounded align-middle animate-pulse" />
                  }
                >
                  <span class="ml-1.5 text-xs text-muted-foreground">{totalCount()}</span>
                </Show>
              </button>
              <button
                class={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                  tab() === "conversations"
                    ? "border-purple-400 text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setTab("conversations")}
              >
                Conversations
                <Show
                  when={conversationsTotal() !== null}
                  fallback={
                    <span class="ml-1.5 inline-block h-3 w-6 bg-accent rounded align-middle animate-pulse" />
                  }
                >
                  <span class="ml-1.5 text-xs text-muted-foreground">{conversationsTotal()}</span>
                </Show>
              </button>
            </div>

            <div class="flex-1 overflow-auto">
              <Switch fallback={<SessionsSkeleton />}>
                <Match when={tab() === "sessions"}>
                  <Show
                    when={sessions()}
                    fallback={
                      <Show when={sessionsQuery.isLoadingError} fallback={<SessionsSkeleton />}>
                        <div class="p-8 text-center text-destructive">
                          Failed to load sessions for this project
                        </div>
                      </Show>
                    }
                  >
                    {(loaded) => (
                      <Show
                        when={loaded().length > 0}
                        fallback={
                          <div class="p-8 text-center text-muted-foreground">
                            No sessions found for this project
                          </div>
                        }
                      >
                        <For each={[...groupByDate(loaded()).entries()]}>
                      {([date, dateSessions]) => (
                        <div>
                          <div class="sticky top-0 z-10 px-4 py-2 bg-background/95 backdrop-blur border-b border-border">
                            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">{date}</span>
                          </div>

                          <div class="divide-y divide-border/50">
                            <For each={dateSessions}>
                              {(session) => {
                                const details = getSessionDetails(session);
                                const isTargetEvent = session.id === highlightEventId();
                                return (
                                  <button
                                    id={`event-${session.id}`}
                                    class={`w-full p-4 text-left transition-colors ${
                                      isTargetEvent
                                        ? "bg-accent ring-2 ring-ring"
                                        : "hover:bg-accent/50"
                                    }`}
                                    onClick={() => {
                                      const date = session.timestamp
                                        ? new Date(session.timestamp as string)
                                            .toISOString()
                                            .slice(0, 10)
                                        : null;
                                      if (date) {
                                        openDay(date, session.id);
                                      }
                                    }}
                                  >
                                    <div class="flex items-start justify-between gap-4">
                                      <div class="flex-1 min-w-0">
                                        <div class="flex items-center gap-2 mb-1">
                                          <span class="font-medium font-mono">
                                            {formatTime(session.timestamp)}
                                          </span>
                                          <Show when={session.end_timestamp}>
                                            <span class="text-muted-foreground font-mono">
                                              - {formatTime(session.end_timestamp)}
                                            </span>
                                          </Show>
                                        </div>
                                        <Show when={details}>
                                          {(d) => (<>
                                            <div class="flex flex-wrap gap-2 text-sm">
                                              <For each={Object.entries(d().languages).slice(0, 3)}>
                                                {([lang]) => (
                                                  <span class="px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs">
                                                    {lang}
                                                  </span>
                                                )}
                                              </For>
                                              <Show when={d().branches.length > 0}>
                                                <span class="text-muted-foreground text-xs">
                                                  {d().branches[0]}
                                                  {d().branches.length > 1 &&
                                                    ` +${d().branches.length - 1}`}
                                                </span>
                                              </Show>
                                            </div>
                                            <div class="text-xs text-muted-foreground mt-1 font-mono">
                                              {d().fileCount} files, {d().heartbeatCount}{" "}
                                              heartbeats
                                            </div>
                                          </>)}
                                        </Show>
                                      </div>
                                      <div class="text-right shrink-0">
                                        <div class="font-bold font-mono text-purple-400">
                                          {formatDuration(session.duration_ms || 0)}
                                        </div>
                                      </div>
                                    </div>
                                  </button>
                                );
                              }}
                            </For>
                          </div>
                        </div>
                      )}
                    </For>

                        <Show when={sessionsQuery.hasNextPage}>
                          <div class="p-4 text-center">
                            <button
                              class="px-4 py-2 text-sm bg-card rounded-md enabled:hover:bg-accent transition-colors disabled:opacity-50"
                              onClick={loadMoreSessions}
                              disabled={sessionsQuery.isFetching}
                            >
                              {sessionsQuery.isFetchingNextPage
                                ? "Loading..."
                                : `Load more (${(totalCount() ?? 0) - loaded().length} remaining)`}
                            </button>
                          </div>
                        </Show>
                      </Show>
                    )}
                  </Show>
                </Match>

                <Match when={tab() === "conversations"}>
                  <Show
                    when={conversations()}
                    fallback={
                      <Show
                        when={conversationsQuery.isLoadingError}
                        fallback={<ConversationsSkeleton />}
                      >
                        <div class="p-8 text-center text-destructive">
                          Failed to load conversations for this project
                        </div>
                      </Show>
                    }
                  >
                    {(loaded) => (
                      <Show
                        when={loaded().length > 0}
                        fallback={
                          <div class="p-8 text-center text-muted-foreground">
                            No AI coding conversations found for this project
                          </div>
                        }
                      >
                        <For each={[...groupConversationsByDate(loaded()).entries()]}>
                          {([date, dateConvos]) => (
                            <div>
                              <div class="sticky top-0 z-10 px-4 py-2 bg-background/95 backdrop-blur border-b border-border">
                                <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">{date}</span>
                              </div>
                              <div class="divide-y divide-border/50">
                                <For each={dateConvos}>
                                  {(convo) => (
                                    <div
                                      role={convo.conversationId ? "button" : undefined}
                                      tabIndex={convo.conversationId ? 0 : undefined}
                                      class={`w-full p-4 text-left transition-colors ${convo.conversationId ? "hover:bg-accent/50 cursor-pointer" : ""}`}
                                      onClick={() => {
                                        if (!convo.conversationId) return;
                                        navigate(
                                          buildConversationUrl(convo.source, convo.conversationId, convo.lastEventId),
                                          { state: { fromCodingProject: projectName() } },
                                        );
                                      }}
                                      onKeyDown={(event) => {
                                        if (!convo.conversationId || (event.key !== "Enter" && event.key !== " ")) return;
                                        event.preventDefault();
                                        navigate(
                                          buildConversationUrl(convo.source, convo.conversationId, convo.lastEventId),
                                          { state: { fromCodingProject: projectName() } },
                                        );
                                      }}
                                    >
                                      <div class="flex items-start justify-between gap-4">
                                        <div class="flex-1 min-w-0">
                                          <div class="flex items-center gap-2 mb-1">
                                            <span
                                              class="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium source-badge"
                                              style={getSourceColorStyle(convo.source)}
                                            >
                                              {sourceLabel(convo.source)}
                                            </span>
                                            <span class="text-xs text-muted-foreground font-mono">
                                              {formatTime(convo.lastMessage)}
                                            </span>
                                          </div>
                                          <div class="text-sm font-medium truncate">
                                            {displayConversationTitle(convo.title, projectName())}
                                          </div>
                                        </div>
                                        <div class="text-right shrink-0 text-xs text-muted-foreground font-mono">
                                          {convo.messageCount}{" "}
                                          {convo.messageCount === 1 ? "msg" : "msgs"}
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>
                          )}
                        </For>

                        <Show when={conversationsQuery.hasNextPage}>
                          <div class="p-4 text-center">
                            <button
                              class="px-4 py-2 text-sm bg-card rounded-md enabled:hover:bg-accent transition-colors disabled:opacity-50"
                              onClick={loadMoreConversations}
                              disabled={conversationsQuery.isFetching}
                            >
                              {conversationsQuery.isFetchingNextPage
                                ? "Loading..."
                                : `Load more (${(conversationsTotal() ?? 0) - loaded().length} remaining)`}
                            </button>
                          </div>
                        </Show>
                      </Show>
                    )}
                  </Show>
                </Match>
              </Switch>
            </div>
          </div>

          <Show when={sidebarOpen()}>
            <div class="w-72 border-l border-border bg-card/30 overflow-auto">
              <div class="p-4 space-y-6">
                <Show
                  when={projectStats()}
                  fallback={
                    <Switch>
                      <Match when={statsQuery.isPending}>
                        <SidebarSkeleton />
                      </Match>
                      <Match when={statsQuery.isLoadingError}>
                        <div class="text-sm text-destructive">Failed to load project stats.</div>
                      </Match>
                      <Match when={!statsQuery.isPending}>
                        <div class="text-sm text-muted-foreground">
                          No WakaTime stats for this project.
                        </div>
                      </Match>
                    </Switch>
                  }
                >
                  {(stats) => (
                    <>
                      <div>
                        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Overview</h3>
                        <div class="space-y-2 text-sm">
                          <div class="flex justify-between">
                            <span class="text-muted-foreground">Total Time</span>
                            <span class="font-medium font-mono text-purple-400">
                              {formatDuration(stats().project.totalDuration)}
                            </span>
                          </div>
                          <div class="flex justify-between">
                            <span class="text-muted-foreground">Sessions</span>
                            <span class="font-mono">{stats().project.sessionCount}</span>
                          </div>
                          <div class="flex justify-between">
                            <span class="text-muted-foreground">First Activity</span>
                            <span class="font-mono">{formatDate(stats().project.firstActivity)}</span>
                          </div>
                          <div class="flex justify-between">
                            <span class="text-muted-foreground">Last Activity</span>
                            <span class="font-mono">{formatDate(stats().project.lastActivity)}</span>
                          </div>
                        </div>
                      </div>

                      <div>
                        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Activity</h3>
                        <Show
                          when={activityChartOption()}
                          fallback={
                            <div class="text-xs text-muted-foreground">No activity data</div>
                          }
                        >
                          {(opt) => (
                            <div class="h-16">
                              <EChartsAutoSize option={chart.option(opt())} />
                            </div>
                          )}
                        </Show>
                      </div>

                      <Show when={stats().byLanguage.length > 0}>
                        <div>
                          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                            Languages
                          </h3>
                          <div class="space-y-2">
                            <For each={stats().byLanguage.slice(0, 8)}>
                              {(lang) => (
                                <div class="flex justify-between text-sm">
                                  <span class="flex items-center gap-2">
                                    <span class="w-2 h-2 rounded-full bg-purple-400" />
                                    {lang.name}
                                  </span>
                                  <span class="text-muted-foreground font-mono">
                                    {formatShortDuration(lang.duration)}
                                  </span>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>

                      <Show when={stats().byBranch.length > 0}>
                        <div>
                          <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                            Branches
                          </h3>
                          <div class="space-y-2">
                            <For each={stats().byBranch.slice(0, 8)}>
                              {(branch) => (
                                <div class="flex justify-between text-sm">
                                  <span class="truncate mr-2">{branch.name}</span>
                                  <span class="text-muted-foreground font-mono shrink-0">
                                    {formatShortDuration(branch.duration)}
                                  </span>
                                </div>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
