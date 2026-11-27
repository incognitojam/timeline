import { MEMORY_KINDS, type MemoryImportContact, type MemoryKind, type MemoryNote, type MemoryVersion } from "@shared/memory";
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, For, Show, Suspense } from "solid-js";
import { formatMemoryDate, KINDS, linkMemoryNotes, scopeLabel } from "../lib/memory";
import {
  useContacts,
  useDeleteMemoryNote,
  useMemoryIndex,
  useMemoryNote,
  useMemoryVersions,
  useRestoreMemoryVersion,
  useUpdateMemoryNote,
} from "../lib/queries";
import { useRestoredScroll } from "../lib/page-scroll";
import { normalizeRouteParam } from "../lib/route-params";
import { APP_NAME, buildContactsUrl, buildMemoryProjectUrl, ROUTES } from "../lib/routes";
import Dialog from "../ui/Dialog";
import { IconChevronLeft, IconChevronRight } from "../ui/icons";
import ContactSelector from "./ContactSelector";
import { Markdown } from "./Markdown";

const BUTTON = "rounded-sm border border-border px-3 py-1.5 text-sm text-foreground transition-colors enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const PRIMARY_BUTTON = "rounded-sm bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-colors enabled:hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const DESTRUCTIVE_BUTTON = "rounded-sm bg-destructive px-3.5 py-1.5 text-sm font-medium text-destructive-foreground transition-colors enabled:hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const FIELD = "mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50";
const LINK_BUTTON = "rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const HEADING = "font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground";

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Details as Markdown, with [[name]] links that open the linked note in this tab. */
function NoteDetails(props: { note: Pick<MemoryNote, "project" | "details"> }) {
  const navigate = useNavigate();
  const index = useMemoryIndex();
  // Without the index, [[name]] stays as written rather than hiding the details.
  const markdown = () => {
    const data = index.data;
    if (data) return linkMemoryNotes(props.note.details, props.note.project, data);
    return index.isError ? props.note.details : "";
  };
  function followNoteLink(event: MouseEvent) {
    const link = (event.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!href?.startsWith(`${ROUTES.MEMORY}/note/`) || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(href);
  }
  return (
    <Show when={props.note.details.trim()} fallback={<p class="text-sm text-muted-foreground">No details.</p>}>
      <div onClick={followNoteLink}>
        <Markdown markdown={markdown()} class="prose prose-sm dark:prose-invert max-w-none break-words" />
      </div>
    </Show>
  );
}

function EditForm(props: { note: MemoryNote; onDone: () => void }) {
  const update = useUpdateMemoryNote();
  const [kind, setKind] = createSignal<MemoryKind>(props.note.kind);
  const [title, setTitle] = createSignal(props.note.title);
  const [summary, setSummary] = createSignal(props.note.summary);
  const [details, setDetails] = createSignal(props.note.details);
  // Only a project's notes can be of kind "project".
  const kinds = MEMORY_KINDS.filter((k) => k !== "project" || props.note.project !== "");

  async function save(event: SubmitEvent) {
    event.preventDefault();
    await update.mutateAsync({
      project: props.note.project,
      name: props.note.name,
      edit: { kind: kind(), title: title(), summary: summary(), details: details() },
    });
    props.onDone();
  }

  return (
    <form class="space-y-4 rounded-lg border border-border bg-card p-4" onSubmit={(event) => void save(event).catch(() => {})}>
      <label class="block text-sm font-medium">
        Title
        <input class={FIELD} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} disabled={update.isPending} />
      </label>
      <label class="block text-sm font-medium">
        Kind
        <select class={FIELD} value={kind()} onChange={(e) => setKind(e.currentTarget.value as MemoryKind)} disabled={update.isPending}>
          <For each={kinds}>{(k) => <option value={k}>{KINDS[k].label}</option>}</For>
        </select>
      </label>
      <label class="block text-sm font-medium">
        Summary
        <input class={FIELD} value={summary()} onInput={(e) => setSummary(e.currentTarget.value)} disabled={update.isPending} />
      </label>
      <label class="block text-sm font-medium">
        Details <span class="font-normal text-muted-foreground">(Markdown; link other notes as [[name]])</span>
        <textarea class={`${FIELD} h-64 font-mono`} value={details()} onInput={(e) => setDetails(e.currentTarget.value)} disabled={update.isPending} />
      </label>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <Show when={update.error}>
          {(error) => <p role="alert" class="mr-auto text-xs text-destructive">{error().message}</p>}
        </Show>
        <button type="button" class={BUTTON} onClick={() => props.onDone()} disabled={update.isPending}>Cancel</button>
        <button type="submit" class={PRIMARY_BUTTON} disabled={update.isPending}>{update.isPending ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

/**
 * The contact a person note is linked to, and the owner's way to change it.
 * A change is chosen, then saved, so whether agents can read the note after it shows first.
 */
function NoteContact(props: { note: MemoryNote; disabled: boolean }) {
  const update = useUpdateMemoryNote();
  const index = useMemoryIndex();
  const [showHidden, setShowHidden] = createSignal(false);
  const contacts = useContacts(() => ({ includeHidden: showHidden() }));
  const [picking, setPicking] = createSignal(false);
  /** The contact to save: one chosen, null to unlink, undefined while nothing is chosen. */
  const [chosen, setChosen] = createSignal<MemoryImportContact | null | undefined>(undefined);
  // A contact since deleted is missing from the index; agents treat it as not hidden.
  const current = () => (props.note.contact_id === null ? null : (index.data?.contacts[props.note.contact_id] ?? null));
  let section: HTMLDivElement | undefined;
  const focusFirstButton = () => queueMicrotask(() => section?.querySelector("button")?.focus());
  const cancel = () => {
    setPicking(false);
    setChosen(undefined);
    update.reset();
    focusFirstButton();
  };
  const choose = (ids: number[]) => {
    // Only a pick changes the choice; removing the chip in the search (Backspace) does not: "Remove link" does that.
    const id = ids.at(-1);
    const found = id === undefined || id === props.note.contact_id ? undefined : contacts.data?.find((contact) => contact.id === id);
    if (!found) return;
    setChosen({ id: found.id, name: found.display_name, hidden: found.hidden === 1 });
    setPicking(false);
    focusFirstButton();
  };
  async function save(contact: MemoryImportContact | null) {
    // What the page says agents can read, before and after; the server refuses the change if either is no longer true.
    const edit = { contactId: contact?.id ?? null, agentsCouldRead: !current()?.hidden, agentsCanRead: !contact?.hidden };
    await update.mutateAsync({ project: props.note.project, name: props.note.name, edit });
    setChosen(undefined);
    focusFirstButton();
  }
  const isPerson = () => props.note.kind === "person";
  const next = () => chosen() ?? null;

  return (
    <div ref={section} class="mb-4 text-sm text-muted-foreground" onKeyDown={(event) => {
      if (event.key === "Escape" && (picking() || chosen() !== undefined)) cancel();
    }}>
      <p>
        <Show when={props.note.contact_id !== null} fallback="Not linked to a contact">
          Linked to{" "}
          <A href={buildContactsUrl({ id: props.note.contact_id ?? undefined })} class="text-foreground underline underline-offset-2 hover:text-primary">
            {index.data ? (current()?.name ?? "a contact no longer in your contacts") : "a contact"}
          </A>
          <Show when={current()?.hidden}> · hidden contact, so this note is kept from agents</Show>
          <Show when={index.data && !current()}> · agents can read this note</Show>
        </Show>
      </p>
      <Show
        when={chosen() !== undefined}
        fallback={
          <Show
            when={picking()}
            fallback={
              <div class="mt-1 flex flex-wrap gap-x-3">
                <Show when={isPerson()}>
                  <button type="button" class={LINK_BUTTON} disabled={props.disabled} onClick={() => setPicking(true)}>
                    {props.note.contact_id === null ? "Choose a contact" : "Choose another contact"}
                  </button>
                </Show>
                <Show when={props.note.contact_id !== null}>
                  <button type="button" class={LINK_BUTTON} disabled={props.disabled} onClick={() => setChosen(null)}>Remove link</button>
                </Show>
              </div>
            }
          >
            <div class="mt-1.5 space-y-2">
              <label class="flex w-fit items-center gap-2">
                <input type="checkbox" checked={showHidden()} onChange={(event) => setShowHidden(event.currentTarget.checked)} />
                Show hidden contacts when choosing
              </label>
              <div class="flex items-start gap-2">
                <div class="min-w-0 flex-1">
                  <ContactSelector
                    selectedContactIds={props.note.contact_id === null ? [] : [props.note.contact_id]}
                    onChange={choose}
                    label={`Contact for ${props.note.title}`}
                    placeholder={`Search contacts for ${props.note.title}`}
                    includeHidden={showHidden()}
                    autofocus
                  />
                </div>
                <button type="button" class={BUTTON} onClick={cancel}>Cancel</button>
              </div>
            </div>
          </Show>
        }
      >
        <div class="mt-2 rounded-lg border border-border bg-card p-3">
          <p class="text-foreground">
            <Show when={next()} fallback="Remove the link to this contact?">
              {(contact) => <>Link to {contact().name}?</>}
            </Show>
            <Show when={next()?.hidden}> · hidden contact, so this note will be kept from agents</Show>
            {/* Agents read a note unless its contact is hidden. */}
            <Show when={current()?.hidden && !next()?.hidden}> · agents will be able to read this note</Show>
          </p>
          <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
            <Show when={update.error}>
              {(error) => <p role="alert" class="mr-auto text-xs text-destructive">{error().message}</p>}
            </Show>
            <button type="button" class={BUTTON} disabled={update.isPending} onClick={cancel}>Cancel</button>
            <button type="button" class={PRIMARY_BUTTON} disabled={update.isPending} onClick={() => void save(next()).catch(() => {})}>
              {update.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function VersionRow(props: { version: MemoryVersion }) {
  const restore = useRestoreMemoryVersion();
  const [open, setOpen] = createSignal(false);
  return (
    <li class="px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="min-w-0 flex-1 text-sm">
          <span class="font-medium">{props.version.title}</span>
          <span class="text-muted-foreground"> · saved {formatDateTime(props.version.updated_at)}, replaced {formatDateTime(props.version.replaced_at)}</span>
        </div>
        <button type="button" class={BUTTON} aria-expanded={open()} onClick={() => setOpen(!open())}>
          {open() ? "Hide" : "View"}
        </button>
        <button type="button" class={BUTTON} disabled={restore.isPending} onClick={() => restore.mutate(props.version.id)}>
          Restore
        </button>
      </div>
      <Show when={restore.error}>
        {(error) => <p role="alert" class="mt-2 text-xs text-destructive">{error().message}</p>}
      </Show>
      <Show when={open()}>
        <div class="mt-3 space-y-2 border-l-2 border-border pl-3">
          <p class="text-xs text-muted-foreground">{KINDS[props.version.kind].label}</p>
          <p class="text-sm">{props.version.summary}</p>
          <NoteDetails note={props.version} />
        </div>
      </Show>
    </li>
  );
}

export default function MemoryNoteView() {
  const params = useParams();
  const [searchParams] = useSearchParams();
  // Keyed by the note's scope, so a draft or open dialog never carries over to another note.
  const key = () => JSON.stringify([normalizeRouteParam(searchParams.project), params.name ?? ""]);
  return (
    <Show when={key()} keyed>
      {(k) => {
        const [project, name] = JSON.parse(k) as [string, string];
        return <NotePage project={project} name={name} />;
      }}
    </Show>
  );
}

function NotePage(props: { project: string; name: string }) {
  const navigate = useNavigate();
  const scope = () => ({ project: props.project, name: props.name });
  const noteQuery = useMemoryNote(scope);
  const versions = useMemoryVersions(scope);
  const remove = useDeleteMemoryNote();
  const [editing, setEditing] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const scrollRef = useRestoredScroll();
  // The project's page for a project's note, else Memory.
  const parentUrl = () => props.project ? buildMemoryProjectUrl(props.project) : ROUTES.MEMORY;
  // Placeholder data is the index's copy: shown, but not edited or deleted.
  const isPlaceholder = () => noteQuery.isPlaceholderData;

  createEffect(() => {
    const title = noteQuery.data?.title;
    document.title = title ? `${title} · Memory · ${APP_NAME}` : `Memory · ${APP_NAME}`;
  });

  const index = useMemoryIndex();

  async function confirmDelete() {
    // Resolves once the index has refetched; a project's last note can take its project with it.
    await remove.mutateAsync(scope());
    const projectRemains = index.data?.projects.some((p) => p.key === props.project) ?? false;
    navigate(projectRemains ? parentUrl() : ROUTES.MEMORY);
  }

  return (
    <div ref={scrollRef} class="h-full overflow-auto">
      <div class="mx-auto max-w-3xl px-4 pt-6 pb-12">
        <nav aria-label="Breadcrumb" class="mb-4 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <A href={ROUTES.MEMORY} class="inline-flex items-center gap-1 hover:text-foreground">
            <IconChevronLeft class="h-4 w-4" aria-hidden /> Memory
          </A>
          <Show when={props.project}>
            {(project) => (
              <>
                <IconChevronRight class="h-4 w-4" aria-hidden />
                <A href={buildMemoryProjectUrl(project())} class="hover:text-foreground">{project()}</A>
              </>
            )}
          </Show>
        </nav>

        <Show when={noteQuery.error}>
          {(error) => <p role="alert" class="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error().message}</p>}
        </Show>
        <Show when={noteQuery.data === null}>
          <p class="rounded-lg bg-card p-6 text-sm text-muted-foreground">
            There is no note named “{scope().name}” in {scopeLabel(scope().project).toLowerCase()}. If it was deleted, restore it from Recently deleted on the Memory page.
          </p>
        </Show>

        <Show when={noteQuery.data}>
          {(note) => (
            <article>
              <header class="mb-6">
                <h1 class="font-display text-2xl font-medium break-words">{note().title}</h1>
                <p class="mt-2 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span>{KINDS[note().kind].label}</span>
                  <span aria-hidden>·</span>
                  <span>{scopeLabel(note().project)}</span>
                  <span aria-hidden>·</span>
                  <span>Updated {formatMemoryDate(note().updated_at)}</span>
                </p>
              </header>

              <Show when={note().kind === "person" || note().contact_id !== null}>
                <NoteContact note={note()} disabled={isPlaceholder()} />
              </Show>

              <Show
                when={editing()}
                fallback={
                  <>
                    <p class="mb-4 text-base text-foreground">{note().summary}</p>
                    <NoteDetails note={note()} />
                    <div class="mt-6 flex gap-2">
                      <button type="button" class={BUTTON} disabled={isPlaceholder()} onClick={() => setEditing(true)}>Edit</button>
                      <button type="button" class={BUTTON} disabled={isPlaceholder()} onClick={() => setConfirming(true)}>Delete</button>
                    </div>
                  </>
                }
              >
                <EditForm note={note()} onDone={() => setEditing(false)} />
              </Show>

              {/* Versions arrive after the note; they must not hold its page back. */}
              <Suspense>
                <Show when={(versions.data ?? []).length > 0}>
                  <section class="mt-10">
                    <h2 class={`${HEADING} mb-2 px-1`}>Previous versions</h2>
                    <ul class="divide-y divide-border rounded-lg border border-border bg-card">
                      <For each={versions.data}>{(version) => <VersionRow version={version} />}</For>
                    </ul>
                  </section>
                </Show>
              </Suspense>

              <Dialog open={confirming()} onClose={() => setConfirming(false)} title="Delete this note?">
                <p class="text-sm text-muted-foreground">
                  Agents will no longer see “{note().title}”. It stays under Recently deleted on the Memory page, where you can restore it.
                </p>
                <Show when={remove.error}>
                  {(error) => <p role="alert" class="mt-3 text-xs text-destructive">{error().message}</p>}
                </Show>
                <div class="mt-5 flex justify-end gap-2">
                  <button type="button" class={BUTTON} onClick={() => setConfirming(false)}>Cancel</button>
                  <button type="button" class={DESTRUCTIVE_BUTTON} disabled={remove.isPending} onClick={() => void confirmDelete().catch(() => {})}>
                    Delete
                  </button>
                </div>
              </Dialog>
            </article>
          )}
        </Show>
      </div>
    </div>
  );
}
