import type { MemoryNote, MemoryProject } from "@shared/memory";
import { A } from "@solidjs/router";
import { For, Index, Show } from "solid-js";
import { ACCOUNT_GROUPS, formatMemoryDate, projectNotesInOrder, scopeLabel } from "../lib/memory";
import { useMemoryIndex, useRestoreMemoryVersion, useSetProjectUsesAccountMemory } from "../lib/queries";
import { buildMemoryNoteUrl } from "../lib/routes";
import { IconChevronRight, IconPsychology } from "../ui/icons";

const HEADING = "font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground";
const LIST = "divide-y divide-border overflow-hidden rounded-lg border border-border bg-card";
const SECONDARY_BUTTON = "shrink-0 rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function NoteRow(props: { note: MemoryNote }) {
  return (
    <li>
      <A
        href={buildMemoryNoteUrl(props.note.project, props.note.name)}
        class="flex flex-col gap-1 px-4 py-3 transition-colors sm:flex-row sm:items-start sm:gap-3 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium text-foreground">{props.note.title}</div>
          <div class="mt-0.5 text-sm text-muted-foreground">{props.note.summary}</div>
        </div>
        <div class="shrink-0 text-xs text-muted-foreground sm:pt-0.5">Updated {formatMemoryDate(props.note.updated_at)}</div>
      </A>
    </li>
  );
}

function ProjectGroup(props: { project: MemoryProject }) {
  const setUse = useSetProjectUsesAccountMemory();
  const switchId = () => `memory-account-${props.project.key}`;
  return (
    <details class="group rounded-lg border border-border bg-card">
      <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <IconChevronRight class="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        <span class="min-w-0 flex-1 truncate">{props.project.key}</span>
        <span class="shrink-0 text-xs font-normal text-muted-foreground">
          {props.project.notes.length} {props.project.notes.length === 1 ? "note" : "notes"}
          <Show when={!props.project.useAccountMemory}> · account memory off</Show>
        </span>
      </summary>
      <div class="border-t border-border px-4 py-3">
        <label for={switchId()} class="flex items-start gap-2 text-sm text-foreground">
          <input
            id={switchId()}
            type="checkbox"
            class="mt-0.5"
            checked={props.project.useAccountMemory}
            disabled={setUse.isPending}
            onChange={(event) => {
              const box = event.currentTarget;
              // On failure, show the saved state again.
              setUse.mutate(
                { project: props.project.key, useAccountMemory: box.checked },
                { onError: () => { box.checked = props.project.useAccountMemory; } },
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
      </div>
      <ul class="divide-y divide-border border-t border-border">
        <For each={projectNotesInOrder(props.project.notes)}>{(note) => <NoteRow note={note} />}</For>
      </ul>
    </details>
  );
}

export default function MemoryView() {
  const query = useMemoryIndex();
  const restore = useRestoreMemoryVersion();
  const isEmpty = () => {
    const data = query.data;
    return data !== undefined && data.account.length === 0 && data.projects.length === 0 && data.deleted.length === 0;
  };

  return (
    <div class="h-full overflow-auto">
      <div class="mx-auto max-w-4xl px-4 pt-6 pb-12">
        <header class="mb-8 flex items-start gap-3">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-secondary text-secondary-foreground">
            <IconPsychology class="h-5 w-5" aria-hidden />
          </span>
          <div class="min-w-0">
            <h1 class="font-display text-2xl font-medium">Memory</h1>
            <p class="mt-1 text-sm text-muted-foreground">
              What AI agents have saved about you, shared by every agent connected to Timeline.
            </p>
          </div>
        </header>

        <Show when={query.error}>
          {(error) => <p role="alert" class="mb-4 rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error().message}</p>}
        </Show>

        <Show when={isEmpty()}>
          <div class="rounded-lg bg-card p-6 text-center text-sm text-muted-foreground">
            No notes yet. Agents save notes here through Timeline's MCP server as they learn your preferences, the people you mention and the projects you work on.
          </div>
        </Show>

        <Show when={query.data}>
          {(data) => (
            <div class="space-y-8">
              <For each={ACCOUNT_GROUPS.map((group) => ({ ...group, notes: data().account.filter((note) => note.kind === group.kind) }))}>
                {(group) => (
                  <Show when={group.notes.length > 0}>
                    <section>
                      <h2 class={`${HEADING} mb-2 px-1`}>{group.label}</h2>
                      <ul class={LIST}>
                        <For each={group.notes}>{(note) => <NoteRow note={note} />}</For>
                      </ul>
                    </section>
                  </Show>
                )}
              </For>

              <Show when={data().projects.length > 0}>
                <section>
                  <h2 class={`${HEADING} mb-2 px-1`}>Projects</h2>
                  <div class="space-y-2">
                    {/* Index, not For: a refetch brings new objects, and an open group must stay open. */}
                    <Index each={data().projects}>{(project) => <ProjectGroup project={project()} />}</Index>
                  </div>
                </section>
              </Show>

              <Show when={data().deleted.length > 0}>
                <section>
                  <h2 class={`${HEADING} mb-2 px-1`}>Recently deleted</h2>
                  <ul class={LIST}>
                    <For each={data().deleted}>
                      {(version) => (
                        <li class="flex items-center gap-3 px-4 py-3">
                          <div class="min-w-0 flex-1">
                            <div class="text-sm font-medium text-muted-foreground">{version.title}</div>
                            <div class="mt-0.5 text-xs text-muted-foreground">
                              {scopeLabel(version.project)} · Deleted {formatMemoryDate(version.replaced_at)}
                            </div>
                          </div>
                          <button
                            type="button"
                            class={SECONDARY_BUTTON}
                            disabled={restore.isPending}
                            onClick={() => restore.mutate(version.id)}
                          >
                            Restore
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                  <Show when={restore.error}>
                    {(error) => <p role="alert" class="mt-2 text-xs text-destructive">{error().message}</p>}
                  </Show>
                </section>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
