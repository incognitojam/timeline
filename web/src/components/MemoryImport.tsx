import type { MemoryImportContact, MemoryImportNote, MemoryImportPerson, MemoryImportResult, MemoryKind } from "@shared/memory";
import { createSignal, For, type JSX, Show } from "solid-js";
import { countKind, KIND_ORDER, KINDS } from "../lib/memory";
import { useClaudeMemoryImport, useContacts, usePreviewClaudeMemoryImport } from "../lib/queries";
import { IconChevronRight } from "../ui/icons";
import ContactSelector from "./ContactSelector";

const BUTTON = "rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const PRIMARY_BUTTON = "rounded-sm bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors enabled:hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const LINK_BUTTON = "rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const SUMMARY = "flex cursor-pointer list-none items-baseline gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden";

type Contact = MemoryImportContact;
/** The owner's changes to the preview's contact links, by note key; a missing key keeps the preview's. */
type LinkChanges = Record<string, Contact | null>;

const noteKey = (note: MemoryImportNote) => `${note.project}/${note.name}`;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** Notes grouped by scope, the account first and then projects by title, each scope's kinds in page order. */
function byScope<Note extends MemoryImportNote>(notes: Note[], projects: Record<string, string>) {
  const title = (project: string) => (project ? (projects[project] ?? project) : "Your account");
  const scopes = [...new Set(notes.map((note) => note.project))]
    .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : title(a).localeCompare(title(b))));
  return scopes.map((project) => ({
    project,
    title: title(project),
    kinds: KIND_ORDER.flatMap((kind) => {
      const ofKind = notes
        .filter((note) => note.project === project && note.kind === kind)
        .sort((a, b) => a.title.localeCompare(b.title));
      return ofKind.length ? [{ kind, notes: ofKind }] : [];
    }),
  }));
}

/** A collapsed line: a chevron and `summary`, with `children` shown on expanding it. */
function Expandable(props: { summary: JSX.Element; children: JSX.Element; class?: string }) {
  return (
    <details class={`group ${props.class ?? ""}`}>
      <summary class={SUMMARY}>
        <IconChevronRight class="h-4 w-4 shrink-0 self-center text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
        <span class="min-w-0">{props.summary}</span>
      </summary>
      <div class="mt-1 pl-5.5">{props.children}</div>
    </details>
  );
}

function KindLine(props: { kind: MemoryKind; notes: MemoryImportNote[]; hint: boolean }) {
  return (
    <Expandable
      summary={
        <>
          <span class="text-foreground">{countKind(props.kind, props.notes.length)}</span>
          <Show when={props.hint && KINDS[props.kind].hint}>{(hint) => <span class="text-muted-foreground"> · {hint()}</span>}</Show>
        </>
      }
    >
      <ul class="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        <For each={props.notes}>{(note) => <li>{note.title}</li>}</For>
      </ul>
    </Expandable>
  );
}

/** Each scope's notes as a heading and one collapsed line per kind. */
function Scopes(props: { notes: MemoryImportNote[]; projects: Record<string, string> }) {
  const scopes = () => byScope(props.notes, props.projects);
  // A kind's hint shows on its first line only.
  const first = (project: string, kind: MemoryKind) => scopes().find((scope) => scope.kinds.some((group) => group.kind === kind))?.project === project;
  return (
    <div class="space-y-3">
      <For each={scopes()}>
        {(scope) => (
          <section aria-label={scope.title}>
            <h3 class="font-medium text-foreground">{scope.title}</h3>
            <div class="mt-1 space-y-1">
              <For each={scope.kinds}>{(group) => <KindLine kind={group.kind} notes={group.notes} hint={first(scope.project, group.kind)} />}</For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}

/** Why the preview linked a person, or did not. */
function matchReason(person: MemoryImportPerson): string {
  switch (person.match.by) {
    case "title":
      return "same name";
    case "alias":
      return `by the alias “${person.match.alias}”`;
    case "none":
    {
      const names = [person.title, ...person.aliases].map((name) => `“${name}”`);
      const more = names.length - 3;
      return `no contact named ${more > 0 ? `${names.slice(0, 3).join(", ")} or ${plural(more, "other name")}` : names.join(" or ")}`;
    }
    case "several":
      return `${person.match.count} contacts have this name${person.match.hidden ? `, ${person.match.hidden === person.match.count ? "all" : person.match.hidden} hidden` : ""}`;
  }
}

function PersonRow(props: {
  person: MemoryImportPerson;
  projectTitle: string | null;
  /** The contact the note will be (or was) saved with. */
  contact: Contact | null;
  changed: boolean;
  imported: boolean;
  /** Whether the contact search offers hidden contacts, as the Contacts page's "Show hidden" does. */
  showHidden: boolean;
  /** Absent once imported. */
  onChange?: (contact: Contact | null | undefined) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const contacts = useContacts(() => ({ includeHidden: props.showHidden }));
  let row: HTMLLIElement | undefined;
  // Closing the search, or a change that replaces the focused button, puts focus on the row's first button.
  const stopEditing = () => {
    setEditing(false);
    queueMicrotask(() => row?.querySelector("button")?.focus());
  };
  const choose = (ids: number[]) => {
    // Only a pick changes the link; removing the chip in the search (Backspace) does not: "Don't link" does that.
    const id = ids.at(-1);
    const found = id === undefined || id === props.contact?.id ? undefined : contacts.data?.find((contact) => contact.id === id);
    if (!found) return;
    props.onChange?.({ id: found.id, name: found.display_name, hidden: found.hidden === 1 });
    stopEditing();
  };
  return (
    <li ref={row} class="py-2">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span class="font-medium text-foreground">{props.person.title}</span>
        <Show when={props.projectTitle}>{(title) => <span class="text-xs text-muted-foreground">{title()}</span>}</Show>
      </div>
      <p class="text-muted-foreground">
        <Show when={props.contact} fallback={<>Not linked · {props.changed ? "your choice" : matchReason(props.person)}</>}>
          {(contact) => (
            <>
              Linked to <span class="text-foreground">{contact().name}</span> · {props.changed ? "your choice" : matchReason(props.person)}
              <Show when={contact().hidden}> · {props.imported ? "listed" : "will be listed"} under Hidden notes</Show>
            </>
          )}
        </Show>
        {/* A note that matched a hidden contact, or could be about one, but is not linked to one. */}
        <Show when={!props.contact?.hidden && (props.person.contact?.hidden || (props.person.match.by === "several" && props.person.match.hidden > 0))}> · {props.imported ? "listed" : "will be listed"} with your other notes</Show>
      </p>
      <Show when={props.onChange}>
        {(onChange) => (
          <Show
            when={editing()}
            fallback={
              <div class="mt-1 flex flex-wrap gap-x-3">
                <button type="button" class={LINK_BUTTON} onClick={() => setEditing(true)}>
                  {props.contact ? "Choose another contact" : "Choose a contact"}
                </button>
                <Show when={props.contact}>
                  <button type="button" class={LINK_BUTTON} onClick={() => { onChange()(null); stopEditing(); }}>Don't link</button>
                </Show>
                <Show when={props.changed}>
                  <button type="button" class={LINK_BUTTON} onClick={() => { onChange()(undefined); stopEditing(); }}>Undo</button>
                </Show>
              </div>
            }
          >
            <div
              class="mt-1.5 flex items-start gap-2"
              onKeyDown={(event) => {
                if (event.key === "Escape") stopEditing();
              }}
            >
              <div class="min-w-0 flex-1">
                <ContactSelector
                  selectedContactIds={props.contact ? [props.contact.id] : []}
                  onChange={choose}
                  label={`Contact for ${props.person.title}`}
                  placeholder={`Search contacts for ${props.person.title}`}
                  includeHidden={props.showHidden}
                  autofocus
                />
              </div>
              <button type="button" class={BUTTON} onClick={stopEditing}>Cancel</button>
            </div>
          </Show>
        )}
      </Show>
    </li>
  );
}

function People(props: { result: MemoryImportResult; changes: LinkChanges; onChange?: (key: string, contact: Contact | null | undefined) => void }) {
  const contactOf = (person: MemoryImportPerson) => {
    // After an import, what the server saved; before, the owner's change or the match.
    if (props.result.imported) return person.saved ?? null;
    const key = noteKey(person);
    return key in props.changes ? props.changes[key] : person.contact;
  };
  const [showHidden, setShowHidden] = createSignal(false);
  const linked = () => props.result.people.filter((person) => contactOf(person) !== null).length;
  const linkedHidden = () => props.result.people.filter((person) => contactOf(person)?.hidden).length;
  const total = () => props.result.people.length;
  return (
    <Expandable
      summary={
        <>
          <span class="font-medium text-foreground">Contacts</span>
          <span class="text-muted-foreground">
            {" "}· {linked()} of {plural(total(), "person", "people")} {props.result.imported ? "linked" : "will be linked"}
            <Show when={linkedHidden() > 0}>; {linkedHidden()} {props.result.imported ? "listed" : "will be listed"} under Hidden notes</Show>
          </span>
        </>
      }
    >
      <p class="text-muted-foreground">
        A person's note linked to a contact is found from that contact, and listed under Hidden notes while the contact is hidden. Notes are matched to contacts by name, ignoring case.
        <Show when={props.onChange}> Change any you disagree with.</Show>
      </p>
      <Show when={props.onChange}>
        <label class="mt-2 flex items-center gap-2 text-muted-foreground">
          <input type="checkbox" checked={showHidden()} onChange={(event) => setShowHidden(event.currentTarget.checked)} />
          Show hidden contacts when choosing
        </label>
      </Show>
      <ul class="divide-y divide-border">
        <For each={byScope(props.result.people, props.result.projects).flatMap((scope) => scope.kinds.flatMap((group) => group.notes))}>
          {(person) => (
            <PersonRow
              person={person}
              projectTitle={person.project ? (props.result.projects[person.project] ?? person.project) : null}
              contact={contactOf(person)}
              changed={props.result.imported ? (person.saved?.id ?? null) !== (person.contact?.id ?? null) : noteKey(person) in props.changes}
              imported={props.result.imported}
              showHidden={showHidden()}
              onChange={props.onChange && ((contact) => props.onChange?.(noteKey(person), contact))}
            />
          )}
        </For>
      </ul>
    </Expandable>
  );
}

function Summary(props: { result: MemoryImportResult; changes: LinkChanges; onChange?: (key: string, contact: Contact | null | undefined) => void }) {
  const added = () => props.result.add.length;
  const existing = () => props.result.existing.length;
  return (
    <div class="space-y-4 text-sm">
      <p class="text-foreground">
        <Show when={added() > 0} fallback={existing() > 0 ? "Nothing new to add: every note this file can import is already in memory." : "Nothing in this file can be imported."}>
          {props.result.imported ? "Added" : "Adds"} {plural(added(), "note")} to memory.
        </Show>
        <Show when={added() > 0 && existing() > 0}> {plural(existing(), "note")} already there {existing() === 1 ? "is" : "are"} left as {existing() === 1 ? "it is" : "they are"}.</Show>
      </p>
      <Show when={added() > 0}>
        <Scopes notes={props.result.add} projects={props.result.projects} />
      </Show>
      <Show when={props.result.people.length > 0}>
        <People result={props.result} changes={props.changes} onChange={props.onChange} />
      </Show>
      <Show when={existing() > 0}>
        <Expandable summary={<span class="text-muted-foreground">{plural(existing(), "note")} already in memory, left as {existing() === 1 ? "it is" : "they are"}</span>}>
          <Scopes notes={props.result.existing} projects={props.result.projects} />
        </Expandable>
      </Show>
      <Show when={props.result.problems.length > 0}>
        <Expandable summary={<span class="text-muted-foreground">{plural(props.result.problems.length, "file")} cannot be imported</span>}>
          <ul class="space-y-1">
            <For each={props.result.problems}>
              {(problem) => (
                <li>
                  <span class="break-all font-mono text-xs">{problem.path}</span>
                  <span class="block text-muted-foreground">{problem.reason}</span>
                </li>
              )}
            </For>
          </ul>
        </Expandable>
      </Show>
      <Show when={props.result.overLimit}>{(message) => <p role="alert" class="text-destructive">{message()}</p>}</Show>
    </div>
  );
}

/**
 * Import from claude.ai's memory: what to upload and where to get it, then a
 * preview of what the file would add, with the contact each person's note
 * links to for the owner to change, then the import.
 */
export default function MemoryImport(props: { onClose: () => void }) {
  let input: HTMLInputElement | undefined;
  const [file, setFile] = createSignal<File | null>(null);
  const [changes, setChanges] = createSignal<LinkChanges>({});
  const preview = usePreviewClaudeMemoryImport();
  const run = useClaudeMemoryImport();
  const error = () => preview.error ?? run.error;
  const canImport = () => {
    const data = preview.data;
    return !run.data && !run.error && data !== undefined && data.add.length > 0 && !data.overLimit;
  };
  const changeLink = (key: string, contact: Contact | null | undefined) =>
    setChanges((current) => {
      const { [key]: _, ...rest } = current;
      return contact === undefined ? rest : { ...rest, [key]: contact };
    });

  const startImport = () => {
    const chosen = file();
    const data = preview.data;
    if (!chosen || !data) return;
    const links = data.people.map((person) => {
      const key = noteKey(person);
      return (key in changes() ? changes()[key] : person.contact)?.id ?? null;
    });
    run.mutate({ file: chosen, planId: data.planId, links });
  };

  return (
    <section aria-label="Import from Claude" class="mb-8 rounded-lg border border-border bg-card p-4">
      <h2 class="text-sm font-medium text-foreground">Import from Claude</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        In claude.ai, open <span class="text-foreground">Settings → Your Claude → Memory</span> and choose <span class="text-foreground">Export memory</span>, then choose the <span class="font-mono text-xs">claude-memory-&lt;date&gt;.zip</span> it downloads. <span class="font-mono text-xs">memories-000.zip</span> from the full data export works too.
      </p>
      <input
        ref={input}
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
          setChanges({});
          setFile(chosen);
          preview.mutate(chosen);
        }}
      />
      <Show when={file()}>
        {(chosen) => (
          <div class="mt-4 border-t border-border pt-3">
            <p class="mb-3 break-all text-xs text-muted-foreground">{chosen().name}</p>
            <Show when={preview.isPending}>
              <p class="text-sm text-muted-foreground">Reading the export…</p>
            </Show>
            <Show when={error()}>{(e) => <p role="alert" class="text-sm text-destructive">{e().message}</p>}</Show>
            <Show when={!error() && run.data}>
              {(data) => <Summary result={data()} changes={changes()} />}
            </Show>
            <Show when={!error() && !run.data && preview.data}>
              {(data) => <Summary result={data()} changes={changes()} onChange={run.isPending ? undefined : changeLink} />}
            </Show>
          </div>
        )}
      </Show>
      <div class="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" class={BUTTON} disabled={run.isPending} onClick={() => props.onClose()}>
          {run.data ? "Done" : "Cancel"}
        </button>
        <Show when={!run.data}>
          <button type="button" class={canImport() ? BUTTON : PRIMARY_BUTTON} disabled={run.isPending} onClick={() => input?.click()}>
            {file() ? "Choose another file" : "Choose file"}
          </button>
        </Show>
        <Show when={canImport()}>
          <button type="button" class={PRIMARY_BUTTON} disabled={run.isPending} onClick={startImport}>
            {run.isPending ? "Importing…" : "Import"}
          </button>
        </Show>
      </div>
    </section>
  );
}
