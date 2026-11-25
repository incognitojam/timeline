import type { MemoryImportResult } from "@shared/memory";
import { createSignal, For, Show } from "solid-js";
import { KIND_LABELS, scopeLabel } from "../lib/memory";
import { useClaudeMemoryImport, usePreviewClaudeMemoryImport } from "../lib/queries";

export const MEMORY_IMPORT_INPUT_ID = "memory-import-file";

const BUTTON = "rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const PRIMARY_BUTTON = "rounded-sm bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors enabled:hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Notes to add per scope, account first, as "Topic 2 · Person 1". */
function scopes(result: MemoryImportResult) {
  const byScope = new Map<string, string[]>();
  for (const group of result.add) {
    const line = byScope.get(group.project) ?? [];
    line.push(`${KIND_LABELS[group.kind]} ${group.count}`);
    byScope.set(group.project, line);
  }
  return [...byScope].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
}

function Summary(props: { result: MemoryImportResult }) {
  const total = () => props.result.add.reduce((sum, group) => sum + group.count, 0);
  return (
    <div class="space-y-3 text-sm">
      <p class="text-foreground">
        {props.result.imported ? "Added" : "Would add"} {plural(total(), "note")}.
        <Show when={props.result.existing > 0}> {plural(props.result.existing, "note")} already in memory left as {props.result.existing === 1 ? "it is" : "they are"}.</Show>
      </p>
      <Show when={total() > 0}>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <For each={scopes(props.result)}>
            {([project, kinds]) => (
              <>
                <dt class="text-muted-foreground">{scopeLabel(project)}</dt>
                <dd class="text-foreground">{kinds.join(" · ")}</dd>
              </>
            )}
          </For>
        </dl>
      </Show>
      <Show when={props.result.links.length > 0}>
        <div>
          <p class="text-muted-foreground">Linked to contacts by exact name:</p>
          <ul class="mt-1 space-y-0.5">
            <For each={props.result.links}>
              {(link) => (
                <li>
                  <span class="font-mono text-xs">{link.project ? `${link.project}/${link.name}` : link.name}</span> → {link.contact}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <Show when={props.result.problems.length > 0}>
        <details>
          <summary class="cursor-pointer text-muted-foreground">{plural(props.result.problems.length, "file")} cannot be imported</summary>
          <ul class="mt-2 space-y-1">
            <For each={props.result.problems}>
              {(problem) => (
                <li>
                  <span class="break-all font-mono text-xs">{problem.path}</span>
                  <span class="block text-muted-foreground">{problem.reason}</span>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
      <Show when={props.result.overLimit}>{(message) => <p role="alert" class="text-destructive">{message()}</p>}</Show>
    </div>
  );
}

/**
 * Import from claude.ai's data export: a preview of what memories-000.zip
 * would add, then the import. Opened by a label for MEMORY_IMPORT_INPUT_ID.
 */
export default function MemoryImport() {
  const [file, setFile] = createSignal<File | null>(null);
  const preview = usePreviewClaudeMemoryImport();
  const run = useClaudeMemoryImport();
  const close = () => {
    setFile(null);
    preview.reset();
    run.reset();
  };
  const error = () => preview.error ?? run.error;
  const result = () => run.data ?? preview.data;
  const canImport = () => {
    const data = preview.data;
    return !run.data && !run.error && data !== undefined && data.add.length > 0 && !data.overLimit;
  };

  return (
    <>
      <input
        id={MEMORY_IMPORT_INPUT_ID}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        class="sr-only"
        tabindex="-1"
        aria-hidden="true"
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!chosen) return;
          run.reset();
          setFile(chosen);
          preview.mutate(chosen);
        }}
      />
      <Show when={file()}>
        {(chosen) => (
          <section aria-label="Import from Claude" class="mb-8 rounded-lg border border-border bg-card p-4">
            <h2 class="text-sm font-medium text-foreground">Import from Claude</h2>
            <p class="mt-0.5 mb-3 break-all text-xs text-muted-foreground">{chosen().name}</p>
            <Show when={preview.isPending}>
              <p class="text-sm text-muted-foreground">Reading the export…</p>
            </Show>
            <Show when={error()}>{(e) => <p role="alert" class="text-sm text-destructive">{e().message}</p>}</Show>
            <Show when={error() ? undefined : result()}>{(data) => <Summary result={data()} />}</Show>
            <div class="mt-4 flex justify-end gap-2">
              <button type="button" class={BUTTON} disabled={run.isPending} onClick={close}>
                {run.data ? "Done" : "Cancel"}
              </button>
              <Show when={canImport()}>
                <button type="button" class={PRIMARY_BUTTON} disabled={run.isPending} onClick={() => {
                  const planId = preview.data?.planId;
                  if (planId) run.mutate({ file: chosen(), planId });
                }}>
                  {run.isPending ? "Importing…" : "Import"}
                </button>
              </Show>
            </div>
          </section>
        )}
      </Show>
    </>
  );
}
