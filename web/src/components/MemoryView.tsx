import type { MemoryNote, MemoryProject } from "@shared/memory";
import { A } from "@solidjs/router";
import { createMemo, createSignal, For, Show } from "solid-js";
import { ACCOUNT_GROUPS, formatMemoryDate, hiddenContactIdsOf, scopeLabel, splitHiddenNotes } from "../lib/memory";
import { useMemoryIndex, useRestoreMemoryVersion } from "../lib/queries";
import { buildMemoryNoteUrl, buildMemoryProjectUrl } from "../lib/routes";
import { IconChevronRight, IconPsychology } from "../ui/icons";
import MemoryImport from "./MemoryImport";

export const HEADING = "font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground";
export const LIST = "divide-y divide-border overflow-hidden rounded-lg border border-border bg-card";
const SECONDARY_BUTTON = "shrink-0 rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** `withProject` names a project note's project, for a list that mixes scopes. */
export function NoteRow(props: { note: MemoryNote; withProject?: boolean }) {
  const index = useMemoryIndex();
  // A person's note says it is not linked, so those stand out, or names its contact when the title does not.
  const contact = () => {
    const linked = props.note.contact_id === null ? undefined : index.data?.contacts[props.note.contact_id];
    if (!linked || linked.name.toLowerCase() === props.note.title.toLowerCase()) return null;
    return linked.name;
  };
  const marker = () => [
    ...(props.withProject && props.note.project ? [scopeLabel(props.note.project)] : []),
    ...(props.note.kind === "person" ? [props.note.contact_id === null ? "Not linked" : contact()] : []),
  ].filter((part) => part).join(" · ");
  return (
    <li>
      <A
        href={buildMemoryNoteUrl(props.note.project, props.note.name)}
        class="flex flex-col gap-1 px-4 py-3 transition-colors sm:flex-row sm:items-start sm:gap-3 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-sm font-medium text-foreground">{props.note.title}</span>
            <Show when={marker()}>
              {(marker) => <span class="text-xs text-muted-foreground">{marker()}</span>}
            </Show>
          </div>
          <div class="mt-0.5 text-sm text-muted-foreground">{props.note.summary}</div>
        </div>
        <div class="shrink-0 text-xs text-muted-foreground sm:pt-0.5">Updated {formatMemoryDate(props.note.updated_at)}</div>
      </A>
    </li>
  );
}

/** Leaves out notes under Hidden notes. */
/** Notes linked to a hidden contact, collapsed at the end of the page as hidden contacts are elsewhere. */
export function HiddenNotes(props: { notes: MemoryNote[]; withProject?: boolean }) {
  return (
    <Show when={props.notes.length > 0}>
      <details class="group">
        <summary class="mb-2 block cursor-pointer list-none rounded-sm px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span class={`${HEADING} flex items-center gap-1`}>
            <IconChevronRight class="-ml-1 h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
            Hidden notes
          </span>
          <span class="mt-0.5 block text-sm text-muted-foreground">Notes about contacts you have hidden.</span>
        </summary>
        <ul class={LIST}>
          <For each={props.notes}>{(note) => <NoteRow note={note} withProject={props.withProject} />}</For>
        </ul>
      </details>
    </Show>
  );
}

function ProjectRow(props: { project: MemoryProject; count: number }) {
  const count = () => props.count;
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
          {(data) => {
            const split = createMemo(() => {
              const hiddenIds = hiddenContactIdsOf(data());
              return {
                account: splitHiddenNotes(data().account, hiddenIds),
                projects: data().projects.map((project) => ({ project, ...splitHiddenNotes(project.notes, hiddenIds) })),
              };
            });
            const account = () => split().account;
            // Every scope's hidden notes, the account's first, so none is left only on a project's page.
            const hidden = () => [...account().hidden, ...split().projects.flatMap((project) => project.hidden)];
            return (
            <div class="space-y-8">
              <For each={ACCOUNT_GROUPS.map((group) => ({ ...group, notes: account().shown.filter((note) => note.kind === group.kind) }))}>
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
                    <For each={split().projects}>{(entry) => <ProjectRow project={entry.project} count={entry.shown.length} />}</For>
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

              <HiddenNotes notes={hidden()} withProject />
            </div>
            );
          }}
        </Show>
      </div>
    </div>
  );
}
