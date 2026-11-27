import { createSignal, For, Show } from "solid-js";
import type { McpCheckpoint } from "../lib/api";
import { useDeleteMcpCheckpoint, useMcpCheckpoints } from "../lib/queries";
import Dialog from "../ui/Dialog";
import { BUTTON, DESTRUCTIVE_BUTTON, When } from "./McpTokensPanel";

const DOC_URL = "https://github.com/incognitojam/timeline/blob/main/docs/user/mcp.md#checkpoints";

export default function McpCheckpointsPanel() {
  const query = useMcpCheckpoints();
  const remove = useDeleteMcpCheckpoint();
  const [deleting, setDeleting] = createSignal<McpCheckpoint | null>(null);

  function askDelete(checkpoint: McpCheckpoint) {
    remove.reset();
    setDeleting(checkpoint);
  }

  async function confirmDelete(checkpoint: McpCheckpoint) {
    await remove.mutateAsync(checkpoint.name);
    if (deleting()?.name === checkpoint.name) setDeleting(null);
  }

  return (
    <section class="mb-8" aria-labelledby="mcp-checkpoints-heading">
      <h2 id="mcp-checkpoints-heading" class="font-display text-lg font-medium">Checkpoints</h2>
      <p class="mt-1 mb-4 text-sm text-muted-foreground">
        Where each named <code>get_updates</code> catch-up left off. <a class="underline hover:text-foreground" href={DOC_URL} target="_blank" rel="noreferrer">How checkpoints work</a>
      </p>

      <Show when={query.isError}>
        <div class="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">Failed to load checkpoints.</div>
      </Show>

      <Show when={query.data}>
        {(data) => (
          <Show
            when={data().checkpoints.length > 0}
            fallback={
              <div class="rounded-lg bg-card p-4 text-sm text-muted-foreground">
                No checkpoints yet. One is created when an agent finishes a <code>get_updates</code> catch-up with <code>checkpoint: "&lt;name&gt;"</code>.
              </div>
            }
          >
            <div class="overflow-x-auto rounded-lg border border-border">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border bg-muted/50">
                    <th class="px-3 py-2 text-left font-medium">Name</th>
                    <th class="px-3 py-2 text-left font-medium">Caught up to</th>
                    <th class="px-3 py-2 text-left font-medium">Last used</th>
                    <th class="px-3 py-2 text-left font-medium">Cleaned up if unused</th>
                    <th class="px-3 py-2"><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={data().checkpoints}>
                    {(checkpoint) => (
                      <tr class="border-b border-border last:border-b-0">
                        <td class="px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">{checkpoint.name}</td>
                        <td class="px-3 py-2 text-muted-foreground">
                          <Show when={checkpoint.added_at} fallback={<>id:{checkpoint.position}</>}>
                            {(at) => <>events added <When at={at()} /></>}
                          </Show>
                        </td>
                        <td class="px-3 py-2 text-muted-foreground"><When at={checkpoint.used_at} /></td>
                        <td class="px-3 py-2 text-muted-foreground"><When at={checkpoint.expires_at} /></td>
                        <td class="px-3 py-2 text-right">
                          <button type="button" class={BUTTON} onClick={() => askDelete(checkpoint)}>Delete</button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        )}
      </Show>

      <Dialog open={deleting() !== null} onClose={() => setDeleting(null)} title="Delete this checkpoint?">
        <Show when={deleting()}>
          {(checkpoint) => (
            <>
              <p class="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                The next <code>get_updates</code> call with checkpoint “{checkpoint().name}” starts fresh, {query.data?.new_checkpoint_days} days back, as if the name were new. Nothing in Timeline's data is removed.
              </p>
              <Show when={remove.error}>
                {(error) => <p role="alert" class="mt-3 text-xs text-destructive">{error().message}</p>}
              </Show>
              <div class="mt-5 flex justify-end gap-2">
                <button type="button" class={BUTTON} onClick={() => setDeleting(null)}>Cancel</button>
                <button type="button" class={DESTRUCTIVE_BUTTON} disabled={remove.isPending} onClick={() => void confirmDelete(checkpoint()).catch(() => {})}>
                  Delete
                </button>
              </div>
            </>
          )}
        </Show>
      </Dialog>
    </section>
  );
}
