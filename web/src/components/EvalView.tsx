import { useSearchParams } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import { createQuery, keepPreviousData } from "@tanstack/solid-query";
import { createMemo, createSignal, For, Show } from "solid-js";
import {
  type EvalExpectation,
  fetchSearch,
  fetchSemanticSearch,
  type SemanticSearchEvent,
} from "../lib/api";
import {
  useAddEvalExpectation,
  useAddEvalQuery,
  useCreateEvalCase,
  useDeleteEvalCase,
  useDeleteEvalExpectation,
  useDeleteEvalQuery,
  useEvalCase,
  useEvalCases,
  useUpdateEvalExpectation,
} from "../lib/queries";
import { parseQuery } from "../lib/query-parser";
import { normalizeRouteParam } from "../lib/route-params";
import { buildEventUrl } from "../lib/routes";
import { getSourceColorStyle } from "../lib/source-styles";
import { IconClose, IconSearch } from "../ui/icons";
import SegmentedControl from "../ui/SegmentedControl";

type PaneMode = "semantic" | "keyword";

const PANE_MODE_OPTIONS = [
  { value: "semantic", label: "Semantic" },
  { value: "keyword", label: "Keyword" },
] as const satisfies readonly { value: PaneMode; label: string }[];

interface RangeDraft {
  source: string;
  conversation_id: string;
  start_timestamp: string;
  end_timestamp: string;
  grade: number;
  note: string;
}

function formatTimestamp(ts: string | Date | null): string {
  if (!ts) return "—";
  const date = ts instanceof Date ? ts : new Date(ts);
  return date.toLocaleString();
}

function describeExpectation(expectation: EvalExpectation): string {
  if (expectation.kind === "none") return "expect nothing (negative control)";
  if (expectation.kind === "event") {
    return `${expectation.source ? sourceLabel(expectation.source) : "?"} @ ${expectation.event_timestamp ?? "?"}`;
  }
  const scope = [
    expectation.source && sourceLabel(expectation.source),
    expectation.conversation_id && `conv ${expectation.conversation_id}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${scope || "any source"} · ${expectation.start_timestamp} → ${expectation.end_timestamp}`;
}

const GRADE_TITLES: Record<number, string> = {
  0: "irrelevant",
  1: "partial / pointer",
  2: "the thing itself",
};

export default function EvalView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = () => {
    const raw = normalizeRouteParam(searchParams.case);
    const id = raw ? parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(id) && id > 0 ? id : undefined;
  };
  const selectCase = (id: number | undefined) =>
    setSearchParams({ case: id === undefined ? undefined : String(id) });

  const casesQuery = useEvalCases();
  const caseQuery = useEvalCase(selectedId);

  const createCase = useCreateEvalCase();
  const deleteCase = useDeleteEvalCase();
  const addQuery = useAddEvalQuery();
  const deleteQuery = useDeleteEvalQuery();
  const addExpectation = useAddEvalExpectation();
  const updateExpectation = useUpdateEvalExpectation();
  const deleteExpectation = useDeleteEvalExpectation();

  const cases = () => casesQuery.data?.cases ?? [];
  const detail = () => caseQuery.data?.case;
  const categories = createMemo(() => [...new Set(cases().map((c) => c.category))].sort());

  // New-case form
  const [newName, setNewName] = createSignal("");
  const [newCategory, setNewCategory] = createSignal("");

  const submitNewCase = (e: Event) => {
    e.preventDefault();
    if (!newName().trim() || !newCategory().trim()) return;
    createCase.mutate(
      { name: newName().trim(), category: newCategory().trim() },
      {
        onSuccess: (data) => {
          setNewName("");
          setNewCategory("");
          selectCase(data.case.id);
        },
      }
    );
  };

  // Query add form
  const [newQueryText, setNewQueryText] = createSignal("");

  // Search pane
  const [paneQuery, setPaneQuery] = createSignal("");
  const [paneMode, setPaneMode] = createSignal<PaneMode>("semantic");
  const [submittedQuery, setSubmittedQuery] = createSignal("");

  const paneSearch = createQuery(() => ({
    queryKey: ["evalSearchPane", paneMode(), submittedQuery()],
    queryFn: async ({ signal }): Promise<SemanticSearchEvent[]> => {
      if (paneMode() === "semantic") {
        const data = await fetchSemanticSearch({ q: submittedQuery(), limit: 20, signal });
        return data.events;
      }
      const data = await fetchSearch(parseQuery(submittedQuery()), undefined, { signal });
      return data.events.slice(0, 20);
    },
    enabled: submittedQuery().trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  }));

  const runSearch = (text: string) => {
    setPaneQuery(text);
    setSubmittedQuery(text.trim());
  };

  // Range expectation draft (prefilled from a result row)
  const [rangeDraft, setRangeDraft] = createSignal<RangeDraft | null>(null);

  const draftRangeFromEvent = (event: SemanticSearchEvent) => {
    const day = event.timestamp ? String(event.timestamp).slice(0, 10) : "";
    setRangeDraft({
      source: event.source,
      conversation_id: event.conversation_id ?? "",
      start_timestamp: day ? `${day}T00:00:00Z` : "",
      end_timestamp: day ? `${day}T23:59:59Z` : "",
      grade: 2,
      note: "",
    });
  };

  const gradeEvent = (event: SemanticSearchEvent, grade: number) => {
    const caseId = selectedId();
    if (caseId === undefined || !event.timestamp) return;
    addExpectation.mutate({
      caseId,
      input: {
        kind: "event",
        event_id: event.id,
        source: event.source,
        event_timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
        grade,
        note: (event.title ?? event.content ?? "").slice(0, 120) || undefined,
      },
    });
  };

  const submitRangeDraft = (e: Event) => {
    e.preventDefault();
    const caseId = selectedId();
    const draft = rangeDraft();
    if (caseId === undefined || !draft) return;
    addExpectation.mutate(
      {
        caseId,
        input: {
          kind: "range",
          source: draft.source.trim() || undefined,
          conversation_id: draft.conversation_id.trim() || undefined,
          start_timestamp: draft.start_timestamp.trim(),
          end_timestamp: draft.end_timestamp.trim(),
          grade: draft.grade,
          note: draft.note.trim() || undefined,
        },
      },
      { onSuccess: () => setRangeDraft(null) }
    );
  };

  const mutationError = () => {
    const failed = [createCase, addQuery, addExpectation, updateExpectation, deleteExpectation, deleteQuery, deleteCase]
      .find((m) => m.isError);
    return failed?.error ? String(failed.error) : null;
  };

  const gradedEventIds = createMemo(() => {
    const graded = new Map<number, number>();
    for (const expectation of detail()?.expectations ?? []) {
      if (expectation.kind === "event" && expectation.event_id !== null) {
        graded.set(expectation.event_id, expectation.grade);
      }
    }
    return graded;
  });

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-7xl mx-auto px-4 py-6 grid gap-6 md:grid-cols-[minmax(240px,320px)_minmax(0,1fr)] items-start">
        {/* Case list */}
        <div class="space-y-3 min-w-0">
          <form onSubmit={submitNewCase} class="rounded-lg bg-card p-3 space-y-2">
            <p class="text-sm font-medium">New case</p>
            <input
              type="text"
              placeholder="name (kebab-case)"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              type="text"
              placeholder="category"
              list="eval-categories"
              value={newCategory()}
              onInput={(e) => setNewCategory(e.currentTarget.value)}
              class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <datalist id="eval-categories">
              <For each={categories()}>{(category) => <option value={category} />}</For>
            </datalist>
            <button
              type="submit"
              class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground enabled:hover:opacity-90 disabled:opacity-50"
              disabled={createCase.isPending}
            >
              Create
            </button>
          </form>

          <div class="space-y-1">
            <For each={cases()} fallback={<p class="text-sm text-muted-foreground px-1">No eval cases yet.</p>}>
              {(evalCase) => (
                <button
                  class={`w-full rounded-lg p-2.5 text-left transition-colors ${
                    selectedId() === evalCase.id ? "bg-accent" : "bg-card hover:bg-accent/50"
                  }`}
                  onClick={() => selectCase(evalCase.id)}
                >
                  <p class="text-sm font-medium truncate">{evalCase.name}</p>
                  <p class="text-xs text-muted-foreground">
                    {evalCase.category} · {evalCase.query_count} quer{evalCase.query_count === 1 ? "y" : "ies"} ·{" "}
                    {evalCase.expectation_count} expected
                  </p>
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Case detail */}
        <Show
          when={detail()}
          fallback={
            <div class="rounded-lg bg-card p-8 text-center text-muted-foreground">
              Select a case, or create one to start labelling.
            </div>
          }
        >
          {(selected) => (
            <div class="space-y-4 min-w-0">
              <div class="rounded-lg bg-card p-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h2 class="font-medium">{selected().name}</h2>
                    <p class="text-xs text-muted-foreground">{selected().category}</p>
                  </div>
                  <button
                    class="text-xs text-muted-foreground hover:text-red-400"
                    onClick={() => {
                      deleteCase.mutate(selected().id, { onSuccess: () => selectCase(undefined) });
                    }}
                  >
                    Delete case
                  </button>
                </div>
                <Show when={selected().notes}>
                  <p class="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{selected().notes}</p>
                </Show>
              </div>

              <Show when={mutationError()}>
                <div class="rounded-lg bg-card p-3 text-sm text-red-400">{mutationError()}</div>
              </Show>

              {/* Queries */}
              <div class="rounded-lg bg-card p-4 space-y-2">
                <p class="text-sm font-medium">Queries</p>
                <For
                  each={selected().queries}
                  fallback={<p class="text-sm text-muted-foreground">No phrasings yet — add one below.</p>}
                >
                  {(query) => (
                    <div class="flex items-center gap-2">
                      <button
                        class="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-background px-2 py-1.5 text-left text-sm hover:bg-accent"
                        title="Run this query in the search pane"
                        onClick={() => runSearch(query.text)}
                      >
                        <IconSearch class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span class="truncate">{query.text}</span>
                      </button>
                      <button
                        class="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-red-400"
                        title="Remove phrasing"
                        onClick={() => deleteQuery.mutate(query.id)}
                      >
                        <IconClose class="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </For>
                <form
                  class="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newQueryText().trim()) return;
                    addQuery.mutate(
                      { caseId: selected().id, text: newQueryText() },
                      { onSuccess: () => setNewQueryText("") }
                    );
                  }}
                >
                  <input
                    type="text"
                    placeholder="Add a phrasing…"
                    value={newQueryText()}
                    onInput={(e) => setNewQueryText(e.currentTarget.value)}
                    class="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="submit"
                    class="rounded-md bg-secondary px-3 py-1.5 text-sm text-secondary-foreground hover:opacity-90"
                  >
                    Add
                  </button>
                </form>
              </div>

              {/* Expectations */}
              <div class="rounded-lg bg-card p-4 space-y-2">
                <p class="text-sm font-medium">Expected results</p>
                <For
                  each={selected().expectations}
                  fallback={
                    <p class="text-sm text-muted-foreground">
                      Nothing labelled yet — grade search results below, or add a range.
                    </p>
                  }
                >
                  {(expectation) => (
                    <div class="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 text-sm">
                      <span class="rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                        {expectation.kind}
                      </span>
                      <span class="min-w-0 flex-1 truncate" title={expectation.note ?? undefined}>
                        <Show when={expectation.kind === "event" && expectation.event_id}>
                          <a class="text-primary hover:underline" href={buildEventUrl(expectation.event_id ?? 0)}>
                            #{expectation.event_id}
                          </a>{" "}
                        </Show>
                        {describeExpectation(expectation)}
                        <Show when={expectation.note}>
                          <span class="text-muted-foreground"> — {expectation.note}</span>
                        </Show>
                      </span>
                      <select
                        class="rounded-md border border-border bg-background px-1 py-0.5 text-xs"
                        title="Grade"
                        value={expectation.grade}
                        onChange={(e) =>
                          updateExpectation.mutate({
                            id: expectation.id,
                            input: { grade: parseInt(e.currentTarget.value, 10) },
                          })
                        }
                      >
                        <For each={[0, 1, 2]}>
                          {(grade) => <option value={grade}>{grade}</option>}
                        </For>
                      </select>
                      <button
                        class="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-red-400"
                        title="Remove expectation"
                        onClick={() => deleteExpectation.mutate(expectation.id)}
                      >
                        <IconClose class="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </For>
                <div class="flex gap-2 pt-1">
                  <button
                    class="rounded-md bg-secondary px-3 py-1.5 text-xs text-secondary-foreground hover:opacity-90"
                    onClick={() =>
                      setRangeDraft({
                        source: "",
                        conversation_id: "",
                        start_timestamp: "",
                        end_timestamp: "",
                        grade: 2,
                        note: "",
                      })
                    }
                  >
                    Add range…
                  </button>
                  <button
                    class="rounded-md bg-secondary px-3 py-1.5 text-xs text-secondary-foreground hover:opacity-90"
                    onClick={() =>
                      addExpectation.mutate({
                        caseId: selected().id,
                        input: { kind: "none", grade: 0, note: "negative control" },
                      })
                    }
                  >
                    Expect nothing
                  </button>
                </div>

                <Show when={rangeDraft()}>
                  {(draft) => (
                    <form onSubmit={submitRangeDraft} class="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-2">
                      <input
                        type="text"
                        placeholder="source (optional)"
                        value={draft().source}
                        onInput={(e) => setRangeDraft({ ...draft(), source: e.currentTarget.value })}
                        class="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      />
                      <input
                        type="text"
                        placeholder="conversation id (optional)"
                        value={draft().conversation_id}
                        onInput={(e) => setRangeDraft({ ...draft(), conversation_id: e.currentTarget.value })}
                        class="rounded-md border border-border bg-background px-2 py-1 text-xs"
                      />
                      <input
                        type="text"
                        placeholder="start (ISO)"
                        required
                        value={draft().start_timestamp}
                        onInput={(e) => setRangeDraft({ ...draft(), start_timestamp: e.currentTarget.value })}
                        class="rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
                      />
                      <input
                        type="text"
                        placeholder="end (ISO)"
                        required
                        value={draft().end_timestamp}
                        onInput={(e) => setRangeDraft({ ...draft(), end_timestamp: e.currentTarget.value })}
                        class="rounded-md border border-border bg-background px-2 py-1 text-xs font-mono"
                      />
                      <input
                        type="text"
                        placeholder="note (optional)"
                        value={draft().note}
                        onInput={(e) => setRangeDraft({ ...draft(), note: e.currentTarget.value })}
                        class="rounded-md border border-border bg-background px-2 py-1 text-xs sm:col-span-2"
                      />
                      <div class="flex items-center gap-2 sm:col-span-2">
                        <label class="text-xs text-muted-foreground">
                          grade{" "}
                          <select
                            class="rounded-md border border-border bg-background px-1 py-0.5 text-xs"
                            value={draft().grade}
                            onChange={(e) => setRangeDraft({ ...draft(), grade: parseInt(e.currentTarget.value, 10) })}
                          >
                            <For each={[0, 1, 2]}>{(grade) => <option value={grade}>{grade}</option>}</For>
                          </select>
                        </label>
                        <button
                          type="submit"
                          class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                        >
                          Add range
                        </button>
                        <button
                          type="button"
                          class="text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => setRangeDraft(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </Show>
              </div>

              {/* Search pane */}
              <div class="rounded-lg bg-card p-4 space-y-3">
                <div class="flex items-center justify-between gap-2">
                  <p class="text-sm font-medium">Find ground truth</p>
                  <SegmentedControl
                    label="Pane search mode"
                    options={PANE_MODE_OPTIONS}
                    value={paneMode()}
                    onChange={setPaneMode}
                  />
                </div>
                <form
                  class="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    runSearch(paneQuery());
                  }}
                >
                  <input
                    type="text"
                    placeholder={paneMode() === "semantic" ? "Describe the target…" : "Keyword search (filters work)…"}
                    value={paneQuery()}
                    onInput={(e) => setPaneQuery(e.currentTarget.value)}
                    class="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="submit"
                    class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                  >
                    Search
                  </button>
                </form>

                <Show when={paneSearch.error}>
                  <p class="text-sm text-red-400">{String(paneSearch.error)}</p>
                </Show>
                <Show when={paneSearch.isFetching && !paneSearch.data}>
                  <p class="text-sm text-muted-foreground">Searching…</p>
                </Show>

                <div class="space-y-1">
                  <For each={paneSearch.data ?? []}>
                    {(event) => (
                      <div class="flex items-start gap-2 rounded-md bg-background px-2 py-1.5">
                        <span
                          class="mt-0.5 inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-xs font-medium source-badge"
                          style={getSourceColorStyle(event.source)}
                        >
                          {sourceLabel(event.source)}
                        </span>
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-sm">{event.title ?? event.content ?? `#${event.id}`}</p>
                          <p class="truncate text-xs text-muted-foreground">
                            {formatTimestamp(event.timestamp)}
                            <Show when={event.content && event.content !== event.title}>
                              {" · "}
                              {event.content}
                            </Show>
                          </p>
                        </div>
                        <Show when={event.distance !== undefined}>
                          <span class="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground" title="Vector distance">
                            {event.distance?.toFixed(3)}
                          </span>
                        </Show>
                        <div class="flex shrink-0 items-center gap-1">
                          <Show
                            when={gradedEventIds().get(event.id) === undefined}
                            fallback={
                              <span class="rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                                graded {gradedEventIds().get(event.id)}
                              </span>
                            }
                          >
                            <For each={[0, 1, 2]}>
                              {(grade) => (
                                <button
                                  class="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                                  title={`Grade ${grade}: ${GRADE_TITLES[grade]}`}
                                  onClick={() => gradeEvent(event, grade)}
                                >
                                  {grade}
                                </button>
                              )}
                            </For>
                          </Show>
                          <button
                            class="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                            title="Expect a range around this event (prefills its conversation + day)"
                            onClick={() => draftRangeFromEvent(event)}
                          >
                            range
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
