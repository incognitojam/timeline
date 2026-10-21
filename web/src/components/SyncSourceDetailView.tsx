import { A, useParams } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import type { EChartsOption } from "echarts";
import { EChartsAutoSize } from "../ui/echarts";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import {
  type SchedulerSourceStatus,
  type SyncSourceInfo,
  waitForJob,
} from "../lib/api";
import { formatDuration, formatIntervalMs, formatRelativeTime } from "../lib/format";
import { useChartTheme } from "../lib/echarts-theme";
import {
  useServiceStatus,
  useSyncHistory,
  useSyncSources,
  useTriggerSyncSource,
} from "../lib/queries";
import { SYNC_SOURCE_HISTORY_LIMIT } from "../lib/query-params";
import { safeDecode } from "../lib/routes";
import {
  getRemainingQueueDepthSeries,
  historyStatusLabel,
  parseSyncHistoryMetadata,
} from "../lib/sync-history";
import { getSourceColorStyle } from "../lib/source-styles";
import { summarizeSyncJob } from "../lib/sync-jobs";
import { syncAuthStatusBadge, syncStatusBadgeClass } from "../lib/sync-auth-status";
import { IconChevronLeft } from "../ui/icons";
import SourceIcon from "./SourceIcon";
import SyncSourceConfigurationForm from "./SyncSourceConfigurationForm";

function formatAbsoluteTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function timestampToIso(timestamp: string): string {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp)) return timestamp;
  return `${timestamp.replace(" ", "T")}Z`;
}

function formatRunDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

function formatCompactCount(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function queueDepthChangeLabel(change: number, sampleCount: number): string {
  if (sampleCount === 1) return "first recorded sample";
  if (change === 0) return "no net change since first sample";
  return `${Math.abs(change).toLocaleString()} ${change < 0 ? "fewer" : "more"} since first sample`;
}

function queueDepthTooltip(params: unknown): string {
  const item = (params as { axisValue?: string | number; value?: unknown }[])[0];
  if (!item || !Array.isArray(item.value)) return "";
  const depth = item.value[1];
  if (typeof depth !== "number") return "";

  const date = typeof item.axisValue === "number" || typeof item.axisValue === "string"
    ? new Date(item.axisValue)
    : null;
  const time = date && !Number.isNaN(date.getTime())
    ? formatAbsoluteTime(date.toISOString())
    : "Queue reading";
  return `${time}<br/><strong>${depth.toLocaleString()} remaining</strong>`;
}

function runStatusLabel(run: { success: boolean; skipped?: boolean }): { label: string; className: string } {
  if (run.skipped) return { label: "Deferred", className: "text-yellow-400" };
  if (run.success) return { label: "Healthy", className: "text-green-400" };
  return { label: "Failing", className: "text-red-400" };
}

export default function SyncSourceDetailView() {
  const chart = useChartTheme();
  const params = useParams();
  const sourceName = () => safeDecode(params.source ?? "");

  const statusQuery = useServiceStatus();
  const syncSourcesQuery = useSyncSources();
  const historyQuery = useSyncHistory(() => ({
    source: sourceName(),
    limit: SYNC_SOURCE_HISTORY_LIMIT,
  }));
  const triggerSyncMutation = useTriggerSyncSource();
  const status = () => statusQuery.data ?? null;
  const syncSources = () => syncSourcesQuery.data?.sources ?? [];
  const history = () => historyQuery.data?.entries ?? [];

  const [syncing, setSyncing] = createSignal(false);
  const [syncMessage, setSyncMessage] = createSignal<{ message: string; success: boolean } | null>(null);
  const [expandedMetadataId, setExpandedMetadataId] = createSignal<number | null>(null);

  const activeSyncPolls = new Set<AbortController>();

  const sourceInfo = (): SyncSourceInfo | null => syncSources().find((src) => src.name === sourceName()) ?? null;

  const refresh = () => {
    void statusQuery.refetch();
    void syncSourcesQuery.refetch();
    void historyQuery.refetch();
  };

  // Abort any in-flight sync triggered for the previous source and clear
  // transient UI state when navigating to a different source. Without this,
  // the previous source's handler would resolve into this view and reset
  // syncing / syncMessage against the wrong source.
  createEffect(on(sourceName, () => {
    for (const c of activeSyncPolls) c.abort();
    activeSyncPolls.clear();
    setSyncing(false);
    setSyncMessage(null);
    setExpandedMetadataId(null);
  }, { defer: true }));

  onCleanup(() => {
    for (const controller of activeSyncPolls) controller.abort();
    activeSyncPolls.clear();
  });

  const sourceStatus = (): SchedulerSourceStatus | null => {
    return status()?.scheduler.sources.find((src) => src.source === sourceName()) ?? null;
  };

  const sourceDescription = () => sourceInfo()?.description ?? sourceStatus()?.description ?? null;
  const isSourceEnabled = () => sourceInfo()?.enabled ?? false;
  const activeJobs = () => {
    const loggedJobIds = new Set(history().map((entry) => entry.job_id));
    return status()?.queue.filter((job) =>
      job.kind === "sync" &&
      job.source === sourceName() &&
      !loggedJobIds.has(job.id)
    ) ?? [];
  };

  // Interval to display: the scheduler's resolved interval when the scheduler
  // is running (bun run service), else the configured interval string from
  // sync_sources — the dev API reports no scheduler sources at all.
  const intervalDisplay = (): string | null => {
    const scheduled = sourceStatus();
    if (scheduled) return formatIntervalMs(scheduled.intervalMs);
    return sourceInfo()?.interval ?? null;
  };

  // Compact status badge shown next to the title.
  const statusBadge = createMemo((): { label: string; tone: string; pulse: boolean } => {
    if (!isSourceEnabled()) return { label: "Disabled", tone: "text-muted-foreground", pulse: false };
    const lastRun = sourceStatus()?.lastRun;
    if (lastRun?.isRunning) return { label: "Running", tone: "text-yellow-400", pulse: true };
    if (lastRun) {
      const s = runStatusLabel(lastRun);
      return { label: s.label, tone: s.className, pulse: false };
    }
    return { label: "No runs yet", tone: "text-muted-foreground", pulse: false };
  });

  const authBadge = () => syncAuthStatusBadge(sourceInfo()?.authStatus);

  const stats = createMemo(() => {
    const entries = history();
    const finished = entries.filter((e) => e.finished_at !== null);
    const total = finished.length;
    const deferred = finished.filter((e) => e.skipped === 1).length;
    const blocked = finished.filter((e) => e.skipped === 1 && e.error !== null).length;
    const completed = finished.filter((e) => e.skipped !== 1);
    const succeeded = completed.filter((e) => e.success === 1).length;
    const failed = completed.filter((e) => e.success === 0).length;
    const successRate = completed.length > 0 ? (succeeded / completed.length) * 100 : null;

    const durations = completed
      .map((e) => e.duration_ms)
      .filter((d): d is number => d !== null && d > 0);
    const avgDurationMs =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : null;

    const totalEventsAdded = entries.reduce((sum, e) => sum + (e.events_added ?? 0), 0);

    return { total, deferred, blocked, succeeded, failed, successRate, avgDurationMs, totalEventsAdded };
  });

  const remainingQueueDepth = createMemo(() => getRemainingQueueDepthSeries(history()));

  const queueDepthSummary = createMemo(() => {
    const points = remainingQueueDepth();
    const first = points[0];
    const latest = points.at(-1);
    if (!first || !latest) return null;
    return {
      latest: latest.depth,
      change: latest.depth - first.depth,
      sampleCount: points.length,
    };
  });

  const queueDepthChartOption = createMemo((): EChartsOption | null => {
    const points = remainingQueueDepth();
    if (points.length === 0) return null;
    const color = chart.palette()[0];

    return {
      animation: false,
      color: [color],
      grid: { top: 12, right: 18, bottom: 28, left: 12, containLabel: true },
      tooltip: {
        trigger: "axis",
        formatter: queueDepthTooltip,
      },
      xAxis: {
        type: "time",
        boundaryGap: ["2%", "2%"],
        axisPointer: { snap: true },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        scale: true,
        axisLabel: { formatter: (value: number) => formatCompactCount(value) },
      },
      series: [{
        name: "Remaining queue depth",
        type: "line",
        data: points.map(({ time, depth }) => [time, depth] as [string, number]),
        showSymbol: true,
        symbol: "circle",
        symbolSize: 5,
        lineStyle: { width: 2 },
        itemStyle: { color },
        areaStyle: { color, opacity: 0.08 },
        emphasis: { focus: "series" },
      }],
    };
  });

  async function handleTriggerSync() {
    if (syncing()) return;
    setSyncing(true);
    setSyncMessage({ message: "Queued...", success: true });

    const controller = new AbortController();
    activeSyncPolls.add(controller);

    try {
      const result = await triggerSyncMutation.mutateAsync(sourceName());
      if (controller.signal.aborted) return;
      if (!result.success || !result.jobId) {
        setSyncMessage({ message: result.message, success: false });
        return;
      }
      setSyncMessage({ message: result.message, success: true });
      try {
        const finalJob = await waitForJob(result.jobId, {
          intervalMs: 1000,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const summary = summarizeSyncJob(finalJob);
        setSyncMessage(summary);
      } catch {
        if (controller.signal.aborted) return;
        setSyncMessage({ message: "Lost track of job — refresh to see result", success: false });
      }
      if (!controller.signal.aborted) refresh();
    } catch {
      if (controller.signal.aborted) return;
      setSyncMessage({ message: "Failed to trigger sync", success: false });
    } finally {
      activeSyncPolls.delete(controller);
      // Aborted handlers (e.g. due to source navigation) leave the syncing
      // flag to whoever cleared it; only natural completion resets it.
      if (!controller.signal.aborted) setSyncing(false);
    }
  }

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <div class="flex items-start gap-3 mb-6">
          <A
            href="/sync"
            class="p-2 hover:bg-accent rounded-md transition-colors"
            title="Back to sync"
          >
            <IconChevronLeft class="w-5 h-5" />
          </A>
          <div class="flex-1 min-w-0">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div class="flex items-center gap-2 min-w-0">
                <span
                  class="flex items-center justify-center w-9 h-9 rounded-sm source-icon text-lg shrink-0"
                  style={getSourceColorStyle(sourceName())}
                >
                  <SourceIcon source={sourceName()} />
                </span>
                <h1 class="font-display text-2xl font-medium truncate">{sourceLabel(sourceName())}</h1>
                <Show when={sourceInfo()}>
                  <span
                    role="status"
                    class={`${syncStatusBadgeClass} ${statusBadge().tone} ${statusBadge().pulse ? "animate-pulse" : ""}`}
                  >
                    {statusBadge().label}
                  </span>
                </Show>
                <Show when={authBadge()}>
                  {(badge) => (
                    <span
                      role="status"
                      class={`${syncStatusBadgeClass} ${badge().tone}`}
                    >
                      {badge().label}
                    </span>
                  )}
                </Show>
              </div>
              <Show when={sourceInfo()}>
                <div class="flex items-center gap-2 ml-auto">
                  <button
                    class="rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm font-medium text-primary transition-colors enabled:hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:border-border disabled:bg-background disabled:text-muted-foreground disabled:opacity-50"
                    disabled={syncing() || !isSourceEnabled()}
                    onClick={handleTriggerSync}
                  >
                    <Show when={!syncing()} fallback={<span class="animate-pulse">Syncing...</span>}>
                      Sync Now
                    </Show>
                  </button>
                </div>
              </Show>
            </div>
            <Show when={sourceDescription()}>
              {(desc) => (
                <div class="text-sm text-muted-foreground mt-1">{desc()}</div>
              )}
            </Show>
          </div>
        </div>

        <Show
          when={!syncSourcesQuery.isError}
          fallback={
            <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
              Failed to load sync source details.
            </div>
          }
        >
          <Show
            when={syncSourcesQuery.data}
            fallback={
              <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                Loading sync source details...
              </div>
            }
          >
            <Show
              when={sourceInfo()}
              fallback={
                <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                  Source <code class="px-1 rounded bg-muted">{sourceLabel(sourceName())}</code> not found.
                  <div class="mt-2">
                    <A href="/sync" class="text-primary hover:underline">
                      ← Back to sync
                    </A>
                  </div>
                </div>
              }
            >
              <>
                {/* Scheduling facts + transient sync message */}
                <div class="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p class="text-sm text-muted-foreground">
                    <Show
                      when={intervalDisplay()}
                      fallback={
                        <Show when={isSourceEnabled()} fallback={<>Automatic sync disabled</>}>
                          No sync schedule configured
                        </Show>
                      }
                    >
                      {(interval) => (
                        <>
                          Syncs every <span class="font-mono">{interval()}</span>
                          <Show
                            when={isSourceEnabled()}
                            fallback={<> · automatic sync disabled</>}
                          >
                            <Show when={sourceStatus()?.nextRunAt}>
                              {(t) => (
                                <> · next run <span class="font-mono">{formatRelativeTime(t())}</span></>
                              )}
                            </Show>
                          </Show>
                        </>
                      )}
                    </Show>
                  </p>
                  <Show when={syncMessage()}>
                    {(msg) => (
                      <span class={`text-sm ${msg().success ? "text-green-400" : "text-red-400"}`}>
                        {msg().message}
                      </span>
                    )}
                  </Show>
                </div>

                {/* Configuration */}
                <div class="mb-6">
                  <Show when={sourceInfo()}>
                    {(source) => <SyncSourceConfigurationForm source={source()} />}
                  </Show>
                </div>

                {/* Aggregate stats */}
                <div class="mb-6">
                  <h3 class="flex items-center gap-2 mb-3">
                    <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Stats
                    </span>
                    <span class="h-px flex-1 bg-border" />
                    <span class="text-sm font-normal text-muted-foreground ml-2">
                      from last <span class="font-mono">{history().length}</span> run{history().length === 1 ? "" : "s"}
                    </span>
                  </h3>
                  <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatTile
                      label="Total runs"
                      value={String(stats().total)}
                      sublabel={stats().deferred > 0 ? `${stats().deferred} deferred` : undefined}
                    />
                    <StatTile
                      label="Success rate"
                      value={
                        stats().successRate === null
                          ? "—"
                          : `${(stats().successRate ?? 0).toFixed(0)}%`
                      }
                      tone={
                        stats().successRate === null
                          ? "neutral"
                          : (stats().successRate ?? 0) >= 95
                            ? "good"
                            : (stats().successRate ?? 0) >= 75
                              ? "warn"
                              : "bad"
                      }
                      sublabel={
                        stats().succeeded + stats().failed > 0
                          ? `${stats().succeeded} ok / ${stats().failed} fail${stats().blocked > 0 ? ` / ${stats().blocked} blocked` : ""}`
                          : undefined
                      }
                    />
                    <StatTile
                      label="Avg duration"
                      value={
                        stats().avgDurationMs === null
                          ? "—"
                          : formatRunDuration(stats().avgDurationMs ?? 0)
                      }
                    />
                    <StatTile
                      label="Events added"
                      value={`+${stats().totalEventsAdded.toLocaleString()}`}
                    />
                  </div>
                </div>

                <Show when={queueDepthSummary()}>
                  {(summary) => (
                    <Show when={queueDepthChartOption()}>
                      {(option) => (
                        <section class="mb-6" aria-labelledby="queue-depth-heading">
                          <div class="flex items-end justify-between gap-4 mb-3">
                            <div>
                              <h3
                                id="queue-depth-heading"
                                class="text-xs font-medium text-muted-foreground uppercase tracking-wider"
                              >
                                Remaining queue depth
                              </h3>
                              <p class="mt-1 text-xs text-muted-foreground">
                                <span class="font-mono">remainingQueueDepth</span>
                                {" · "}
                                {summary().sampleCount} completed run{summary().sampleCount === 1 ? "" : "s"}
                              </p>
                            </div>
                            <div class="text-right shrink-0">
                              <div class="font-mono tabular-nums text-xl leading-none">
                                {summary().latest.toLocaleString()}
                              </div>
                              <div class="mt-1 text-xs text-muted-foreground">
                                {queueDepthChangeLabel(summary().change, summary().sampleCount)}
                              </div>
                            </div>
                          </div>
                          <div
                            class="h-56 rounded-lg border border-border bg-card/50 p-2"
                            role="img"
                            aria-label={`Remaining queue depth over time. Latest ${summary().latest.toLocaleString()}; ${queueDepthChangeLabel(summary().change, summary().sampleCount)}.`}
                          >
                            <EChartsAutoSize option={chart.option(option())} />
                          </div>
                        </section>
                      )}
                    </Show>
                  )}
                </Show>

                {/* Run history */}
                <div>
                  <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Run history</h3>
                  <Show
                    when={!historyQuery.isError}
                    fallback={
                      <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                        Failed to load run history.
                      </div>
                    }
                  >
                    <Show
                      when={activeJobs().length > 0 || history().length > 0}
                      fallback={
                        <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                          No runs recorded yet.
                        </div>
                      }
                    >
                      <div class="rounded-lg border border-border overflow-hidden">
                      <table class="w-full text-sm">
                        <thead>
                          <tr class="border-b border-border bg-muted/50">
                            <th class="text-left px-3 py-2 font-medium">Started</th>
                            <th class="text-left px-3 py-2 font-medium">Duration</th>
                            <th class="text-left px-3 py-2 font-medium">Status</th>
                            <th class="text-right px-3 py-2 font-medium">Events</th>
                            <th class="text-left px-3 py-2 font-medium">Details</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={activeJobs()}>
                            {(job) => {
                              const timestamp = timestampToIso(job.startedAt ?? job.enqueuedAt);
                              return (
                                <tr class="border-b border-border last:border-0 hover:bg-muted/30">
                                  <td class="px-3 py-2">
                                    <div title={formatAbsoluteTime(timestamp)}>
                                      <span class="font-mono">{formatRelativeTime(timestamp)}</span>
                                    </div>
                                    <div class="text-xs text-muted-foreground font-mono">
                                      {formatAbsoluteTime(timestamp)}
                                    </div>
                                  </td>
                                  <td class="px-3 py-2 text-muted-foreground">—</td>
                                  <td class="px-3 py-2">
                                    <span class="text-yellow-400 animate-pulse">
                                      {job.status === "running" ? "Running" : "Queued"}
                                    </span>
                                  </td>
                                  <td class="px-3 py-2 text-right text-muted-foreground">—</td>
                                  <td class="px-3 py-2 text-xs text-muted-foreground">
                                    Job <span class="font-mono">#{job.id}</span>
                                  </td>
                                </tr>
                              );
                            }}
                          </For>
                          <For each={history()}>
                            {(entry) => {
                              const metadata = parseSyncHistoryMetadata(entry.metadata);
                              const hasMetadata = metadata !== null;
                              const isExpanded = () => expandedMetadataId() === entry.id;
                              return (
                                <>
                                  <tr class="border-b border-border last:border-0 hover:bg-muted/30">
                                    <td class="px-3 py-2">
                                      <div title={formatAbsoluteTime(entry.started_at + "Z")}>
                                        <span class="font-mono">{formatRelativeTime(entry.started_at + "Z")}</span>
                                      </div>
                                      <div class="text-xs text-muted-foreground font-mono">
                                        {formatAbsoluteTime(entry.started_at + "Z")}
                                      </div>
                                    </td>
                                    <td class="px-3 py-2 text-muted-foreground">
                                      <span class="font-mono">{entry.duration_ms ? formatRunDuration(entry.duration_ms) : "—"}</span>
                                    </td>
                                    <td class="px-3 py-2">
                                      <Show
                                        when={entry.finished_at !== null}
                                        fallback={
                                          <span class="text-yellow-400 animate-pulse">Running</span>
                                        }
                                      >
                                        {(() => {
                                          const status = historyStatusLabel(entry);
                                          return <span class={status.className} title={status.title}>{status.label}</span>;
                                        })()}
                                      </Show>
                                    </td>
                                    <td class="px-3 py-2 text-right text-muted-foreground">
                                      <Show when={entry.events_added > 0}>
                                        <span class="font-mono">+{entry.events_added}</span>
                                      </Show>
                                      <Show when={entry.events_updated > 0}>
                                        <span class="ml-1 font-mono">~{entry.events_updated}</span>
                                      </Show>
                                    </td>
                                    <td class="px-3 py-2">
                                      <Show when={entry.error}>
                                        <div
                                          class="text-red-400 text-xs max-w-md truncate"
                                          title={entry.error ?? undefined}
                                        >
                                          {entry.error}
                                        </div>
                                      </Show>
                                      <Show when={hasMetadata}>
                                        <button
                                          class="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                                          onClick={() =>
                                            setExpandedMetadataId(isExpanded() ? null : entry.id)
                                          }
                                        >
                                          {isExpanded() ? "hide metadata" : "show metadata"}
                                        </button>
                                      </Show>
                                    </td>
                                  </tr>
                                  <Show when={hasMetadata && isExpanded()}>
                                    <tr class="border-b border-border last:border-0 bg-muted/20">
                                      <td colspan="5" class="px-3 py-2">
                                        <pre class="text-xs text-muted-foreground whitespace-pre-wrap overflow-x-auto">
                                          {JSON.stringify(metadata, null, 2)}
                                        </pre>
                                      </td>
                                    </tr>
                                  </Show>
                                </>
                              );
                            }}
                          </For>
                        </tbody>
                      </table>
                      </div>
                    </Show>
                  </Show>
                </div>
              </>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

function StatTile(props: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: "good" | "warn" | "bad" | "neutral";
}) {
  const toneClass = () => {
    switch (props.tone) {
      case "good":
        return "text-green-400";
      case "warn":
        return "text-yellow-400";
      case "bad":
        return "text-red-400";
      default:
        return "";
    }
  };
  return (
    <div class="rounded-lg bg-card p-3">
      <div class="text-xs text-muted-foreground mb-1">{props.label}</div>
      <div class={`text-xl font-semibold font-mono ${toneClass()}`}>{props.value}</div>
      <Show when={props.sublabel}>
        <div class="text-xs text-muted-foreground mt-0.5">{props.sublabel}</div>
      </Show>
    </div>
  );
}
