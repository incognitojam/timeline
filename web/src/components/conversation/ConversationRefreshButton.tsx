import { sourceLabel } from "@shared/sources";
import { createSignal, onCleanup, Show } from "solid-js";
import { type Job, listJobs, waitForJob } from "../../lib/api";
import { useSyncSources, useTriggerSyncSource } from "../../lib/queries";
import { summarizeSyncJob } from "../../lib/sync-jobs";
import { IconSync } from "../../ui/icons";

type Phase = { kind: "idle" } | { kind: "starting" } | { kind: "queued"; notBefore: Date | null } | { kind: "running" };

function queuedPhase(job: Job): Phase {
  // not_before is a UTC "YYYY-MM-DD HH:MM:SS" timestamp; a future one is a retry waiting out its back-off.
  const notBefore = new Date(`${job.notBefore.replace(" ", "T")}Z`);
  return { kind: "queued", notBefore: notBefore.getTime() > Date.now() ? notBefore : null };
}

function phaseLabel(phase: Phase): string {
  switch (phase.kind) {
    case "idle":
      return "";
    case "starting":
      return "Starting sync…";
    case "running":
      return "Syncing…";
    case "queued":
      return phase.notBefore
        ? `Waiting to retry until ${phase.notBefore.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "Queued…";
  }
}

/**
 * Runs the conversation's source sync through the same job queue the sync page uses.
 * No source can sync a single conversation, so the whole source runs.
 */
export function ConversationRefreshButton(props: {
  source: string;
  /** Current message count, read before and after the sync to report what arrived. */
  countMessages: () => Promise<number>;
  /** Pull the newest messages into the view once the sync has finished. */
  onSynced: () => Promise<void>;
}) {
  const syncSources = useSyncSources();
  const triggerSync = useTriggerSyncSource();
  // Checked before reading data so a pending list hides the button instead of suspending the header.
  const canSync = () =>
    syncSources.isSuccess && syncSources.data.sources.some((s) => s.name === props.source && s.enabled);

  const [phase, setPhase] = createSignal<Phase>({ kind: "idle" });
  const [result, setResult] = createSignal<{ message: string; success: boolean } | null>(null);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const busy = () => phase().kind !== "idle";

  const run = async () => {
    if (busy()) return;
    setResult(null);
    setPhase({ kind: "starting" });
    try {
      const before = await props.countMessages();
      // Join a sync of this source that is already queued or running rather than
      // queueing another full run behind it.
      const active = await listJobs({ kind: "sync", source: props.source, status: ["running", "queued"], limit: 1 });
      let jobId = active.jobs[0]?.id;
      if (jobId === undefined) {
        const started = await triggerSync.mutateAsync(props.source);
        if (!started.success || started.jobId === undefined) {
          setResult({ message: started.message, success: false });
          return;
        }
        jobId = started.jobId;
      }
      const job = await waitForJob(jobId, {
        signal: controller.signal,
        onUpdate: (update) => setPhase(update.status === "queued" ? queuedPhase(update) : { kind: "running" }),
      });
      if (job.status === "failed") {
        setResult({ message: `Sync failed: ${job.error ?? "unknown error"}`, success: false });
        return;
      }
      if (job.status !== "succeeded" || job.result?.skipped === true) {
        setResult(summarizeSyncJob(job));
        return;
      }
      await props.onSynced();
      const added = (await props.countMessages()) - before;
      setResult({
        success: true,
        message: added > 0 ? `${added} new message${added === 1 ? "" : "s"}` : "Up to date",
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setResult({ message: error instanceof Error ? error.message : "Refresh failed", success: false });
    } finally {
      if (!controller.signal.aborted) setPhase({ kind: "idle" });
    }
  };

  return (
    <Show when={canSync()}>
      <div class="flex items-center gap-2">
        <Show when={busy() ? phaseLabel(phase()) : result()?.message}>
          {(text) => (
            <span
              role="status"
              class={`hidden md:inline text-xs ${result()?.success === false && !busy() ? "text-destructive" : "text-muted-foreground"}`}
            >
              {text()}
            </span>
          )}
        </Show>
        <button
          class="p-2 rounded hover:bg-accent text-muted-foreground disabled:opacity-60"
          onClick={run}
          disabled={busy()}
          aria-busy={busy()}
          aria-label="Refresh"
          title={`Sync ${sourceLabel(props.source)} now. This runs the whole source, not just this conversation.`}
        >
          <IconSync class={`w-5 h-5 ${busy() ? "animate-spin" : ""}`} />
        </button>
      </div>
    </Show>
  );
}
