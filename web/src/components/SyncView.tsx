import { A } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import { createSignal, For, onCleanup, Show } from "solid-js";
import {
  type Job,
  type SyncHistoryEntry,
  waitForJob,
} from "../lib/api";
import { formatDuration, formatIntervalMs, formatRelativeTime } from "../lib/format";
import { useInboxSources, useServiceStatus, useSyncHistory, useSyncSources, useTriggerSyncSource, useUploadInboxFile } from "../lib/queries";
import { SYNC_HISTORY_LIMIT } from "../lib/query-params";
import { getSourceColorStyle } from "../lib/source-styles";
import { syncAuthStatusBadge, syncStatusBadgeClass } from "../lib/sync-auth-status";
import { historyStatusLabel } from "../lib/sync-history";
import { summarizeSyncJob } from "../lib/sync-jobs";
import SourceIcon from "./SourceIcon";

type ActivityEntry =
  | { type: "job"; job: Job }
  | { type: "history"; entry: SyncHistoryEntry };

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function timestampToIso(timestamp: string): string {
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp)) return timestamp;
  return `${timestamp.replace(" ", "T")}Z`;
}

function jobSource(job: Job): string {
  return job.source ?? job.kind;
}

function jobActivityLabel(job: Job): string {
  if (job.kind === "sync") return "Sync";
  if (job.kind === "inbox-process") return "Inbox";
  return job.kind;
}

function runStatusLabel(run: { success: boolean; skipped?: boolean }): { label: string; className: string } {
  if (run.skipped) return { label: "Deferred", className: "text-yellow-400" };
  if (run.success) return { label: "OK", className: "text-green-400" };
  return { label: "ERR", className: "text-red-400" };
}

type SyncActionState = "idle" | "queueing" | "queued" | "running" | "disabled";
type PendingSyncActionState = Extract<SyncActionState, "queueing" | "queued" | "running">;
type SyncMessage = { message: string; success: boolean };

const SYNC_ACTION_LABEL: Record<SyncActionState, string> = {
  idle: "Sync Now",
  queueing: "Queueing…",
  queued: "Queued",
  running: "Running…",
  disabled: "Disabled",
};

const SYNC_ACTION_TITLE: Record<SyncActionState, string> = {
  idle: "Queue a sync run for this source",
  queueing: "Sending the sync request…",
  queued: "A sync run is already queued for this source",
  running: "A sync run is already in progress for this source",
  disabled: "This source is disabled in the scheduler",
};

const SYNC_ACTION_BUTTON_CLASS: Record<SyncActionState, string> = {
  idle: "border-border bg-background text-foreground enabled:hover:bg-accent",
  queueing: "border-border bg-background text-muted-foreground",
  queued: "border-border bg-background text-yellow-400/90 enabled:hover:bg-accent",
  running: "border-border bg-background text-yellow-400",
  disabled: "border-border/60 bg-background text-muted-foreground opacity-70",
};

function activeSyncJobFor(queue: Job[], source: string): Job | null {
  return (
    queue.find(
      (job) =>
        job.kind === "sync" &&
        job.source === source &&
        (job.status === "queued" || job.status === "running")
    ) ?? null
  );
}

function SyncStatePip(props: { state: SyncActionState }) {
  return (
    <Show when={props.state === "queueing" || props.state === "queued" || props.state === "running"}>
      <span
        aria-hidden="true"
        class={`h-1.5 w-1.5 shrink-0 rounded-full ${
          props.state === "running"
            ? "bg-yellow-400"
            : props.state === "queueing"
              ? "bg-yellow-400/60 animate-pulse motion-reduce:animate-none"
              : "border border-yellow-400/70"
        }`}
      />
    </Show>
  );
}

function ActivitySourceLabel(props: { source: string; linked: boolean }) {
  const content = () => (
    <>
      <span><SourceIcon source={props.source} /></span>
      <span>{sourceLabel(props.source)}</span>
    </>
  );

  return (
    <Show
      when={props.linked}
      fallback={<span class="inline-flex items-center gap-1.5">{content()}</span>}
    >
      <A
        href={`/sync/${encodeURIComponent(props.source)}`}
        aria-label={`View ${sourceLabel(props.source)} sync details`}
        class="inline-flex items-center gap-1.5 rounded-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {content()}
      </A>
    </Show>
  );
}

export default function SyncView() {
  const statusQuery = useServiceStatus();
  const historyQuery = useSyncHistory(() => ({ limit: SYNC_HISTORY_LIMIT }));
  const inboxSourcesQuery = useInboxSources();
  const syncSourcesQuery = useSyncSources();
  const triggerSyncMutation = useTriggerSyncSource();
  const uploadInboxFileMutation = useUploadInboxFile();

  const status = () => statusQuery.data ?? null;
  const history = () => historyQuery.data?.entries ?? [];
  const inboxSources = () => inboxSourcesQuery.data ?? null;

  const [pendingSyncActions, setPendingSyncActions] = createSignal<Record<string, PendingSyncActionState>>({});
  const [syncMessages, setSyncMessages] = createSignal<Record<string, SyncMessage>>({});

  // Upload state
  const [selectedSource, setSelectedSource] = createSignal("");
  const [selectedFile, setSelectedFile] = createSignal<File | null>(null);
  const [uploadMessage, setUploadMessage] = createSignal<{ message: string; success: boolean } | null>(null);
  const selectedSourceInfo = () => inboxSources()?.sources.find((s) => s.name === selectedSource());

  // Background tracker for the most recent upload's processing job. Held
  // outside `uploading` so the upload button re-enables as soon as the file
  // is on disk; the user can queue another upload while polling continues.
  let uploadJobAbort: AbortController | null = null;

  // All in-flight sync-trigger polls. handleTriggerSync registers its own
  // AbortController here for the duration of the poll, so the cleanup hook
  // can abort everything when the component unmounts.
  const activeSyncPolls = new Set<AbortController>();

  // History filter
  const [historyFilter, setHistoryFilter] = createSignal("");

  async function refresh() {
    await Promise.all([statusQuery.refetch(), historyQuery.refetch()]);
  }

  function setPendingSyncAction(source: string, state: PendingSyncActionState | null) {
    setPendingSyncActions((states) => {
      const next = { ...states };
      if (state === null) delete next[source];
      else next[source] = state;
      return next;
    });
  }

  function setSyncMessage(source: string, message: SyncMessage | null) {
    setSyncMessages((messages) => {
      const next = { ...messages };
      if (message === null) delete next[source];
      else next[source] = message;
      return next;
    });
  }

  onCleanup(() => {
    uploadJobAbort?.abort();
    for (const controller of activeSyncPolls) {
      controller.abort();
    }
    activeSyncPolls.clear();
  });

  function summarizeInboxJob(job: Job): { message: string; success: boolean } {
    if (job.status === "succeeded") {
      const result = job.result ?? {};
      const filesProcessed =
        typeof result.filesProcessed === "number" ? result.filesProcessed : 0;
      const eventsAdded = typeof result.eventsAdded === "number" ? result.eventsAdded : 0;
      const errors = Array.isArray(result.errors) ? (result.errors as string[]) : [];

      if (errors.length > 0) {
        // Partial success: some files imported, some failed. The job succeeded
        // (work was done) but the UI should surface the per-file errors.
        return {
          success: filesProcessed > 0,
          message: `Processed ${filesProcessed} file(s), +${eventsAdded} events; ${errors.length} error(s): ${errors[0]}`,
        };
      }

      return {
        success: true,
        message: filesProcessed > 0
          ? `Processed ${filesProcessed} file(s), +${eventsAdded} events`
          : "Processing complete (no new files)",
      };
    }
    if (job.status === "cancelled") {
      return { success: false, message: "Processing was cancelled" };
    }
    return { success: false, message: job.error ?? "Processing failed" };
  }

  async function handleTriggerSync(source: string) {
    setPendingSyncAction(source, "queueing");
    setSyncMessage(source, null);

    const controller = new AbortController();
    activeSyncPolls.add(controller);

    try {
      const result = await triggerSyncMutation.mutateAsync(source);
      if (controller.signal.aborted) return;
      if (!result.success || !result.jobId) {
        setSyncMessage(source, { message: result.message, success: false });
        return;
      }
      setPendingSyncAction(source, "queued");
      if (result.deduped) {
        setSyncMessage(source, { message: result.message, success: true });
      }
      try {
        const finalJob = await waitForJob(result.jobId, {
          intervalMs: 1000,
          signal: controller.signal,
          onUpdate: (job) => {
            if (job.status === "queued" || job.status === "running") {
              setPendingSyncAction(source, job.status);
            }
          },
        });
        if (controller.signal.aborted) return;
        const summary = summarizeSyncJob(finalJob);
        setSyncMessage(source, summary);
      } catch {
        if (controller.signal.aborted) return;
        setSyncMessage(source, { message: "Lost track of job — refresh to see result", success: false });
      }
      if (!controller.signal.aborted) {
        await refresh();
      }
    } catch {
      if (controller.signal.aborted) return;
      setSyncMessage(source, { message: "Failed to trigger sync", success: false });
    } finally {
      activeSyncPolls.delete(controller);
      setPendingSyncAction(source, null);
    }
  }

  function trackUploadJob(jobId: number): void {
    // Cancel any previous tracker so its update doesn't clobber this one.
    uploadJobAbort?.abort();
    const controller = new AbortController();
    uploadJobAbort = controller;

    void (async () => {
      try {
        const finalJob = await waitForJob(jobId, { intervalMs: 1000, signal: controller.signal });
        if (controller.signal.aborted) return;
        setUploadMessage(summarizeInboxJob(finalJob));
        await refresh();
      } catch {
        if (controller.signal.aborted) return;
        setUploadMessage({ message: "Lost track of job — refresh to see result", success: false });
      } finally {
        if (uploadJobAbort === controller) uploadJobAbort = null;
      }
    })();
  }

  async function handleUpload() {
    const file = selectedFile();
    const source = selectedSource();
    if (!file || !source) return;

    setUploadMessage({ message: "Uploading...", success: true });

    let result: Awaited<ReturnType<typeof uploadInboxFileMutation.mutateAsync>>;
    try {
      result = await uploadInboxFileMutation.mutateAsync({ file, source });
    } catch {
      setUploadMessage({ message: "Upload failed", success: false });
      return;
    }

    if (!result.success) {
      setUploadMessage({ message: result.message, success: false });
      return;
    }

    setSelectedFile(null);
    const input = document.getElementById("file-upload") as HTMLInputElement | null;
    if (input) input.value = "";
    setUploadMessage({ message: result.message, success: true });

    if (result.jobId) {
      trackUploadJob(result.jobId);
    }
  }

  const filteredHistory = () => {
    const filter = historyFilter();
    if (!filter) return history();
    return history().filter((e) => e.source === filter);
  };

  const queuedJobs = () => status()?.queue.filter((job) => job.status === "queued") ?? [];
  const isSyncSource = (source: string) => syncSourcesQuery.data?.sources.some((entry) => entry.name === source) ?? false;

  const filteredActivity = (): ActivityEntry[] => {
    const filter = historyFilter();
    const jobs = queuedJobs()
      .filter((job) => !filter || jobSource(job) === filter)
      .map((job) => ({ type: "job" as const, job }));
    return [
      ...jobs,
      ...filteredHistory().map((entry) => ({ type: "history" as const, entry })),
    ];
  };

  // Unique sources in history for filter dropdown
  const historySources = () => {
    const sources = new Set([
      ...history().map((e) => e.source),
      ...queuedJobs().map(jobSource),
    ]);
    return Array.from(sources).sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b)));
  };

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-6xl mx-auto px-4 py-6">
        {/* Header */}
        <div class="flex items-center justify-between mb-6">
          <h2 class="font-display text-2xl font-medium">Sync</h2>
          <Show when={status()}>
            {(s) => {
              const queuedCount = () => s().queue.filter((j) => j.status === "queued").length;
              const runningCount = () => s().queue.filter((j) => j.status === "running").length;
              const queueLabel = () =>
                queuedCount() === 0 && runningCount() === 0
                  ? "idle"
                  : `${queuedCount()} queued, ${runningCount()} running`;
              return (
                <div class="text-sm text-muted-foreground">
                  Uptime: {formatDuration(s().service.uptime * 1000)}
                  {" | "}
                  Scheduler: {s().scheduler.enabled ? "on" : "off"}
                  {" | "}
                  Inbox watcher: {s().inbox.enabled ? "on" : "off"}
                  {" | "}
                  Queue: {queueLabel()}
                </div>
              );
            }}
          </Show>
        </div>

        {/* Sync Sources */}
        <div class="mb-8">
          <h3 class="flex items-center gap-2 mb-4">
            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Sync Sources
            </span>
            <span class="h-px flex-1 bg-border" />
            <Show when={status()}>
              {(s) => (
                <span class="text-xs font-normal text-muted-foreground ml-2">
                  <span class="font-mono">{s().scheduler.sources.length}</span> configured
                </span>
              )}
            </Show>
          </h3>
          <Show
            when={!statusQuery.isError}
            fallback={
              <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                Failed to load sync sources.
              </div>
            }
          >
            <Show
              when={status()}
              fallback={
                <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                  Loading sync sources...
                </div>
              }
            >
              {(s) => (
                <Show
                  when={s().scheduler.sources.length > 0}
                  fallback={
                    <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                      No sync sources configured. The scheduler is {s().scheduler.enabled ? "enabled" : "disabled"}.
                    </div>
                  }
                >
                  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <For each={s().scheduler.sources}>
                      {(source) => {
                        const authBadge = () => {
                          const authStatus = syncSourcesQuery.data?.sources.find(
                            (entry) => entry.name === source.source
                          )?.authStatus;
                          return authStatus === "connected" ? null : syncAuthStatusBadge(authStatus);
                        };
                        const activeJob = () => activeSyncJobFor(s().queue, source.source);
                        const actionState = (): SyncActionState => {
                          const pendingState = pendingSyncActions()[source.source];
                          if (pendingState) return pendingState;
                          const job = activeJob();
                          if (job?.status === "running" || source.lastRun?.isRunning) return "running";
                          if (job) return "queued";
                          if (!source.enabled) return "disabled";
                          return "idle";
                        };
                        const triggerEnabled = () => {
                          const state = actionState();
                          return source.enabled && (
                            state === "idle" ||
                            (state === "queued" && pendingSyncActions()[source.source] === undefined)
                          );
                        };
                        const actionTitle = () => {
                          if (actionState() === "queued" && triggerEnabled()) {
                            return "Prioritize this queued sync";
                          }
                          return SYNC_ACTION_TITLE[actionState()];
                        };
                        return (
                        <A
                          href={`/sync/${encodeURIComponent(source.source)}`}
                          class="source-card source-card-interactive block cursor-pointer rounded-lg border p-4 text-inherit no-underline transition hover:brightness-110"
                          style={getSourceColorStyle(source.source)}
                        >
                        <div class="flex items-center justify-between mb-2">
                          <span class="flex items-center gap-2 font-medium">
                            <span class="text-lg"><SourceIcon source={source.source} /></span>
                            {sourceLabel(source.source)}
                          </span>
                          <div class="flex items-center gap-2">
                            <Show when={authBadge()}>
                              {(badge) => (
                                <span class={`${syncStatusBadgeClass} ${badge().tone}`}>
                                  {badge().label}
                                </span>
                              )}
                            </Show>
                            <span class="text-xs text-muted-foreground">
                              every <span class="font-mono">{formatIntervalMs(source.intervalMs)}</span>
                            </span>
                          </div>
                        </div>

                        {/* Last run info */}
                        <Show when={source.lastRun} fallback={
                          <div class="text-sm text-muted-foreground mb-2">No runs yet</div>
                        }>
                          {(lastRun) => (
                            <div class="text-sm mb-2 space-y-0.5">
                              <div class="flex items-center gap-1.5">
                                <Show when={!lastRun().isRunning} fallback={
                                  <span class="text-yellow-400 animate-pulse">Running</span>
                                }>
                                  {(() => {
                                    const status = runStatusLabel(lastRun());
                                    return <span class={status.className}>{status.label}</span>;
                                  })()}
                                </Show>
                                <span class="text-muted-foreground">
                                  <span class="font-mono">{formatRelativeTime(lastRun().time)}</span>
                                </span>
                                <Show when={lastRun().durationMs > 0}>
                                  <span class="text-muted-foreground">
                                    (<span class="font-mono">{formatDuration(lastRun().durationMs)}</span>)
                                  </span>
                                </Show>
                              </div>
                              <Show when={lastRun().eventsAdded > 0}>
                                <div class="text-muted-foreground">
                                  <span class="font-mono">+{lastRun().eventsAdded}</span> events
                                </div>
                              </Show>
                              <Show when={lastRun().error}>
                                <div class="text-red-400 text-xs truncate" title={lastRun().error ?? undefined}>
                                  {lastRun().error}
                                </div>
                              </Show>
                            </div>
                          )}
                        </Show>

                        {/* Next run */}
                        <Show when={source.nextRunAt}>
                          {(nextRun) => (
                            <div class="text-xs text-muted-foreground mb-2">
                              Next: <span class="font-mono">{formatRelativeTime(nextRun())}</span>
                            </div>
                          )}
                        </Show>

                        {/* Sync message for this source */}
                        <Show when={syncMessages()[source.source]}>
                          {(message) => (
                            <div class={`text-xs mb-2 ${message().success ? "text-green-400" : "text-red-400"}`}>
                              {message().message}
                            </div>
                          )}
                        </Show>

                        {/* Sync now button */}
                        <button
                          type="button"
                          class={`w-full mt-1 flex cursor-not-allowed items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors enabled:cursor-pointer motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${SYNC_ACTION_BUTTON_CLASS[actionState()]}`}
                          disabled={!triggerEnabled()}
                          title={actionTitle()}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleTriggerSync(source.source);
                          }}
                        >
                          <SyncStatePip state={actionState()} />
                          <span>{SYNC_ACTION_LABEL[actionState()]}</span>
                        </button>
                        </A>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              )}
            </Show>
          </Show>
        </div>

        {/* File Upload */}
        <div class="mb-8">
          <h3 class="flex items-center gap-2 mb-4">
            <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">File Upload</span>
            <span class="h-px flex-1 bg-border" />
          </h3>
          <Show
            when={!inboxSourcesQuery.isError}
            fallback={
              <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                Failed to load inbox sources.
              </div>
            }
          >
            <Show
              when={inboxSources()}
              fallback={
                <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                  Loading inbox sources...
                </div>
              }
            >
              {(inbox) => (
                <Show
                  when={inbox().sources.length > 0}
                  fallback={
                    <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                      No inbox sources configured. Add inbox sources in config.toml to enable file uploads.
                    </div>
                  }
                >
            <div class="rounded-lg bg-card p-4">
              <div class="flex flex-col sm:flex-row gap-3">
                {/* Source selector */}
                <select
                  class="px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm"
                  value={selectedSource()}
                  onChange={(e) => setSelectedSource(e.currentTarget.value)}
                >
                  <option value="">Select source...</option>
                  <For each={inbox().sources.filter((s) => s.enabled)}>
                    {(source) => (
                      <option value={source.name}>
                        {sourceLabel(source.name)}
                        {source.parser !== source.name ? ` (${sourceLabel(source.parser)})` : ""}
                      </option>
                    )}
                  </For>
                </select>

                {/* File input */}
                <input
                  id="file-upload"
                  type="file"
                  class="flex-1 px-3 py-2 rounded-md border border-border bg-background text-sm file:mr-3 file:px-3 file:py-1 file:rounded-md file:border-0 file:bg-accent file:text-foreground file:text-sm"
                  onChange={(e) => {
                    const files = e.currentTarget.files;
                    setSelectedFile(files && files.length > 0 ? files[0] : null);
                  }}
                />

                {/* Upload button */}
                <button
                  class="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground enabled:hover:bg-primary/90 transition-colors disabled:opacity-50"
                  disabled={!selectedSource() || !selectedFile() || uploadInboxFileMutation.isPending}
                  onClick={handleUpload}
                >
                  <Show when={!uploadInboxFileMutation.isPending} fallback="Uploading...">
                    Upload
                  </Show>
                </button>
              </div>

              {/* Account info */}
              <Show when={selectedSourceInfo()}>
                {(info) => (
                  <div class="mt-2 text-sm">
                    <Show
                      when={info().account}
                      fallback={
                        <span class="text-yellow-500">No account configured — processing may fail</span>
                      }
                    >
                      {(account) => <span class="text-muted-foreground">Account: <span class="font-mono">{account()}</span></span>}
                    </Show>
                  </div>
                )}
              </Show>

              {/* Selected file info */}
              <Show when={selectedFile()}>
                {(file) => (
                  <div class="mt-2 text-sm text-muted-foreground">
                    {file().name} (<span class="font-mono">{formatBytes(file().size)}</span>)
                  </div>
                )}
              </Show>

              {/* Upload message */}
              <Show when={uploadMessage()}>
                {(msg) => (
                  <div class={`mt-2 text-sm ${msg().success ? "text-green-400" : "text-red-400"}`}>
                    {msg().message}
                  </div>
                )}
              </Show>
            </div>
                </Show>
              )}
            </Show>
          </Show>
        </div>

        {/* Inbox Stats */}
        <Show when={status()?.inbox.sources.length}>
          <div class="mb-8">
            <h3 class="flex items-center gap-2 mb-4">
              <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Inbox History
              </span>
              <span class="h-px flex-1 bg-border" />
              <span class="text-sm font-normal text-muted-foreground ml-2">
                files processed via inbox
              </span>
            </h3>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <For each={status()?.inbox.sources}>
                {(source) => (
                  <div
                    class="rounded-lg border p-4 source-card"
                    style={getSourceColorStyle(source.source)}
                  >
                    <div class="flex items-center gap-2 mb-2">
                      <span class="text-lg"><SourceIcon source={source.source} /></span>
                      <span class="font-medium">{sourceLabel(source.source)}</span>
                    </div>
                    <div class="text-sm space-y-0.5 text-muted-foreground">
                      <div><span class="font-mono">{source.filesProcessed}</span> files (<span class="font-mono">{formatBytes(source.totalSize)}</span>)</div>
                      <div><span class="font-mono">+{source.totalEvents}</span> events</div>
                      <Show when={source.lastProcessed}>
                        <div>Last: <span class="font-mono">{formatRelativeTime(source.lastProcessed + "Z")}</span></div>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Recent Sync History */}
        <div>
          <div class="flex items-center justify-between gap-3 mb-4">
            <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Recent Activity</h3>
            <span class="h-px flex-1 bg-border" />
            <select
              class="px-2 py-1 rounded-md border border-border bg-background text-foreground text-sm"
              value={historyFilter()}
              onChange={(e) => setHistoryFilter(e.currentTarget.value)}
            >
              <option value="">All sources</option>
              <For each={historySources()}>
                {(source) => <option value={source}>{sourceLabel(source)}</option>}
              </For>
            </select>
          </div>

          <Show
            when={!historyQuery.isError}
            fallback={
              <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                Failed to load sync history.
              </div>
            }
          >
            <Show
              when={filteredActivity().length > 0}
              fallback={
                <div class="rounded-lg bg-card p-6 text-muted-foreground text-center">
                  No sync history yet.
                </div>
              }
            >
            <div class="rounded-lg border border-border overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border bg-muted/50">
                    <th class="text-left px-3 py-2 font-medium">Source</th>
                    <th class="text-left px-3 py-2 font-medium">Time</th>
                    <th class="text-left px-3 py-2 font-medium">Duration</th>
                    <th class="text-left px-3 py-2 font-medium">Status</th>
                    <th class="text-right px-3 py-2 font-medium">Events</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={filteredActivity()}>
                    {(activity) => {
                      if (activity.type === "job") {
                        const job = activity.job;
                        return (
                          <tr class="border-b border-border last:border-0">
                            <td class="px-3 py-2">
                              <span class="flex items-center gap-1.5">
                                <ActivitySourceLabel
                                  source={jobSource(job)}
                                  linked={job.kind === "sync" && isSyncSource(jobSource(job))}
                                />
                                <span class="text-xs text-muted-foreground">
                                  {jobActivityLabel(job)} <span class="font-mono">#{job.id}</span>
                                </span>
                              </span>
                            </td>
                            <td class="px-3 py-2 text-muted-foreground">
                              <span class="font-mono">{formatRelativeTime(timestampToIso(job.enqueuedAt))}</span>
                            </td>
                            <td class="px-3 py-2 text-muted-foreground">—</td>
                            <td class="px-3 py-2">
                              <span class="text-yellow-400">Queued</span>
                              <Show when={job.notBefore !== job.enqueuedAt}>
                                <span class="text-muted-foreground">
                                  {" until "}<span class="font-mono">{formatRelativeTime(timestampToIso(job.notBefore))}</span>
                                </span>
                              </Show>
                            </td>
                            <td class="px-3 py-2 text-right text-muted-foreground">—</td>
                          </tr>
                        );
                      }

                      const entry = activity.entry;
                      return (
                        <tr class="border-b border-border last:border-0">
                          <td class="px-3 py-2">
                            <ActivitySourceLabel source={entry.source} linked={isSyncSource(entry.source)} />
                          </td>
                          <td class="px-3 py-2 text-muted-foreground">
                            <span class="font-mono">{formatRelativeTime(entry.started_at + "Z")}</span>
                          </td>
                          <td class="px-3 py-2 text-muted-foreground">
                            <span class="font-mono">{entry.duration_ms ? formatDuration(entry.duration_ms) : "—"}</span>
                          </td>
                          <td class="px-3 py-2">
                            <Show when={entry.finished_at !== null} fallback={
                              <span class="text-yellow-400 animate-pulse">Running</span>
                            }>
                              {(() => {
                                const status = historyStatusLabel(entry);
                                return (
                                  <span class={status.className} title={status.title}>
                                    {status.label}
                                  </span>
                                );
                              })()}
                            </Show>
                          </td>
                          <td class="px-3 py-2 text-right">
                            <Show when={entry.events_added > 0}>
                              <span class="font-mono">+{entry.events_added}</span>
                            </Show>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
