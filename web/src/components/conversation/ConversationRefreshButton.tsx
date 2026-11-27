import { sourceLabel } from "@shared/sources";
import { createSignal, onCleanup, Show } from "solid-js";
import { type Job, refreshConversation, waitForJob } from "../../lib/api";
import { useConversationRefresh } from "../../lib/queries";
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
      return "Starting…";
    case "running":
      return "Refreshing…";
    case "queued":
      return phase.notBefore
        ? `Waiting to retry until ${phase.notBefore.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "Queued…";
  }
}

/** The result line for a finished refresh job. */
function outcome(job: Job): { message: string; success: boolean } {
  if (job.status === "failed") return { message: `Refresh failed: ${job.error ?? "unknown error"}`, success: false };
  if (job.status === "cancelled") return { message: "Refresh was cancelled", success: false };
  const result = job.result ?? {};
  const metadata = (result.metadata ?? {}) as { cancelled?: boolean; moreRemaining?: boolean };
  if (metadata.cancelled) return { message: "Refresh was cancelled", success: false };
  const added = typeof result.eventsAdded === "number" ? result.eventsAdded : 0;
  const summary = added > 0 ? `${added} new message${added === 1 ? "" : "s"}` : "Up to date";
  return { success: true, message: metadata.moreRemaining ? `${summary}, more to fetch` : summary };
}

/**
 * Fetches new messages for this one conversation. Shown only where the server
 * says the conversation can be refreshed; the refresh runs as a job in the
 * worker, queued behind a full sync of the same source when one is running.
 */
export function ConversationRefreshButton(props: {
  source: string;
  conversationId: string;
  /** Pull the newest messages into the view once the refresh has stored them. */
  onRefreshed: () => Promise<void>;
}) {
  const check = useConversationRefresh(() => ({ source: props.source, conversationId: props.conversationId }));
  // Checked before reading data so a pending check hides the button instead of suspending the header.
  const canRefresh = () => check.isSuccess && check.data.refreshable;

  const [phase, setPhase] = createSignal<Phase>({ kind: "idle" });
  const [result, setResult] = createSignal<{ message: string; success: boolean } | null>(null);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const busy = () => phase().kind !== "idle";

  const run = async () => {
    if (busy()) return;
    // The view is keyed per conversation, so once it is disposed props describe another one.
    const disposed = () => controller.signal.aborted;
    setResult(null);
    setPhase({ kind: "starting" });
    try {
      const { jobId } = await refreshConversation(props.source, props.conversationId);
      if (disposed()) return;
      const job = await waitForJob(jobId, {
        signal: controller.signal,
        onUpdate: (update) => setPhase(update.status === "queued" ? queuedPhase(update) : { kind: "running" }),
      });
      const finished = outcome(job);
      if (finished.success) {
        try {
          await props.onRefreshed();
        } catch (error) {
          if (disposed()) return;
          const reason = error instanceof Error ? error.message : String(error);
          setResult({ message: `Refreshed, but couldn't load new messages: ${reason}`, success: false });
          return;
        }
      }
      if (!disposed()) setResult(finished);
    } catch (error) {
      if (disposed()) return;
      setResult({ message: error instanceof Error ? error.message : "Refresh failed", success: false });
    } finally {
      if (!disposed()) setPhase({ kind: "idle" });
    }
  };

  return (
    <Show when={canRefresh()}>
      <div class="flex items-center gap-2">
        <Show when={busy() ? phaseLabel(phase()) : result()?.message}>
          {(text) => (
            <span
              role="status"
              title={text()}
              class={`max-w-48 truncate text-xs ${result()?.success === false && !busy() ? "text-destructive" : "text-muted-foreground"}`}
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
          title={`Fetch new messages in this conversation from ${sourceLabel(props.source)}`}
        >
          <IconSync class={`w-5 h-5 ${busy() ? "animate-spin" : ""}`} />
        </button>
      </div>
    </Show>
  );
}
