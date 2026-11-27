import { A, useParams } from "@solidjs/router";
import { createEffect, For, Show } from "solid-js";
import { projectNotesInOrder } from "../lib/memory";
import { backToPrevious } from "../lib/back-link";
import { useMemoryIndex, useSetProjectUsesAccountMemory } from "../lib/queries";
import { APP_NAME, ROUTES } from "../lib/routes";
import { IconChevronLeft } from "../ui/icons";
import { HEADING, LIST, NoteRow } from "./MemoryView";

/** One project's notes and its account-memory setting, read from the memory index. */
export default function MemoryProjectView() {
  const params = useParams();
  const key = () => params.key ?? "";
  const query = useMemoryIndex();
  const setUse = useSetProjectUsesAccountMemory();
  const project = () => query.data?.projects.find((p) => p.key === key());
  const switchId = () => `memory-account-${key()}`;

  createEffect(() => {
    document.title = `${key()} · Memory · ${APP_NAME}`;
  });

  return (
    <div>
      <div class="mx-auto max-w-4xl px-4 pt-6 pb-12">
        <A href={ROUTES.MEMORY} onClick={backToPrevious} class="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <IconChevronLeft class="h-4 w-4" aria-hidden /> Memory
        </A>
        <h1 class="mb-6 font-display text-2xl font-medium break-words">{key()}</h1>

        <Show when={query.error}>
          {(error) => <p role="alert" class="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error().message}</p>}
        </Show>
        <Show when={query.data && !project()}>
          <p class="rounded-lg bg-card p-6 text-sm text-muted-foreground">
            There are no notes in project “{key()}”. If they were deleted, restore them from Recently deleted on the Memory page.
          </p>
        </Show>

        <Show when={project()}>
          {(project) => (
            <div class="space-y-8">
              <section class="rounded-lg border border-border bg-card px-4 py-3">
                <label for={switchId()} class="flex items-start gap-2 text-sm text-foreground">
                  <input
                    id={switchId()}
                    type="checkbox"
                    class="mt-0.5"
                    checked={project().useAccountMemory}
                    disabled={setUse.isPending}
                    onChange={(event) => {
                      const box = event.currentTarget;
                      const saved = project().useAccountMemory;
                      // On failure, show the saved state again.
                      setUse.mutate(
                        { project: key(), useAccountMemory: box.checked },
                        { onError: () => { box.checked = saved; } },
                      );
                    }}
                  />
                  <span>
                    Use account memory
                    <span class="mt-0.5 block text-xs text-muted-foreground">
                      When off, list_memory for this project lists only its own notes. Agents still receive the account's notes when they connect, since those instructions are the same for every project.
                    </span>
                  </span>
                </label>
                <Show when={setUse.error}>
                  {(error) => <p role="alert" class="mt-2 text-xs text-destructive">{error().message}</p>}
                </Show>
              </section>

              {/* A project with account memory off stays listed after its last note goes. */}
              <Show when={project().notes.length > 0}>
                <section>
                  <h2 class={`${HEADING} mb-2 px-1`}>Notes</h2>
                  <ul class={LIST}>
                    <For each={projectNotesInOrder(project().notes)}>{(note) => <NoteRow note={note} />}</For>
                  </ul>
                </section>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
