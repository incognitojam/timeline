import type { MemoryNote, MemoryProject } from "@shared/memory";
import { A } from "@solidjs/router";
import { createSignal, For, Show } from "solid-js";
import { ACCOUNT_GROUPS, formatMemoryDate, scopeLabel } from "../lib/memory";
import { useMemoryIndex, useRestoreMemoryVersion } from "../lib/queries";
import { buildMemoryNoteUrl, buildMemoryProjectUrl } from "../lib/routes";
import { IconChevronRight, IconPsychology } from "../ui/icons";
import MemoryImport from "./MemoryImport";

export const HEADING = "font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground";
export const LIST = "divide-y divide-border overflow-hidden rounded-lg border border-border bg-card";
const SECONDARY_BUTTON = "shrink-0 rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function NoteRow(props: { note: MemoryNote }) {
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

function ProjectRow(props: { project: MemoryProject }) {
  const count = () => props.project.notes.length;
  return (
    <li>
      <A
        href={buildMemoryProjectUrl(props.project.key)}
        class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{props.project.key}</span>
        <span class="shrink-0 text-xs text-muted-foreground">
          {count()} {count() === 1 ? "note" : "notes"}
          <Show when={!props.project.useAccountMemory}> · account memory off</Show>
        </span>
        <IconChevronRight class="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
      </A>
    </li>
  );
}

export default function MemoryView() {
  const query = useMemoryIndex();
  const restore = useRestoreMemoryVersion();
  const [importing, setImporting] = createSignal(false);
  const isEmpty = () => {
    const data = query.data;
    return data !== undefined && data.account.length === 0 && data.projects.length === 0 && data.deleted.length === 0;
  };

  return (
    <div>
      <div class="mx-auto max-w-4xl px-4 pt-6 pb-12">
        <header class="mb-8 flex flex-wrap items-start gap-3">
          <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-secondary text-secondary-foreground">
            <IconPsychology class="h-5 w-5" aria-hidden />
          </span>
          <div class="min-w-0 flex-1 basis-64">
            <h1 class="font-display text-2xl font-medium">Memory</h1>
            <p class="mt-1 text-sm text-muted-foreground">
              What AI agents have saved about you, shared by every agent connected to Timeline.
            </p>
          </div>
          <button type="button" class={`${SECONDARY_BUTTON} ml-12 sm:ml-0`} aria-expanded={importing()} onClick={() => setImporting((open) => !open)}>
            Import from Claude
          </button>
        </header>

        <Show when={importing()}>
          <MemoryImport onClose={() => setImporting(false)} />
        </Show>

        <Show when={query.error}>
          {(error) => <p role="alert" class="mb-4 rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error().message}</p>}
        </Show>

        <Show when={isEmpty()}>
          <div class="rounded-lg bg-card p-6 text-center text-sm text-muted-foreground">
            No notes yet. Agents save notes here through Timeline's MCP server as they learn your preferences, the people you mention and the projects you work on. To start from what claude.ai remembers, use Import from Claude.
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
                  <ul class={LIST}>
                    <For each={data().projects}>{(project) => <ProjectRow project={project} />}</For>
                  </ul>
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
