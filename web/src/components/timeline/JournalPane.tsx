import { createSignal, createEffect, on, createResource, For, Show, onCleanup } from "solid-js";
import { createMutation, useQueryClient } from "@tanstack/solid-query";
import { sourceLabel } from "@shared/sources";
import { Markdown } from "../Markdown";
import { createLocalStorageSignal } from "../../lib/createLocalStorageSignal";
import { formatTime } from "../../lib/format";
import {
  fetchJournalState,
  type JournalQuestion,
} from "../../lib/api";
import { queryKeys, useDeleteManualEvent, useJournalState, useSaveJournalAnswer, useSaveJournalReflection } from "../../lib/queries";

import { fetchModels, groupModelsByProvider, formatContextLength } from "../../lib/llmModels";
import { IconChevronRight, IconClose } from "../../ui/icons";

/** Derive a short display name from a model ID */
function modelDisplayName(id: string): string {
  const parts = id.split("/");
  const name = parts[parts.length - 1].replace(/:free$/, "");
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  activity: { label: "Activity", color: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  social: { label: "Social", color: "bg-green-500/15 text-green-600 dark:text-green-400" },
  media: { label: "Media", color: "bg-purple-500/15 text-purple-600 dark:text-purple-400" },
  work: { label: "Work", color: "bg-orange-500/15 text-orange-600 dark:text-orange-400" },
  open: { label: "Open", color: "bg-gray-500/15 text-gray-600 dark:text-gray-400" },
  gratitude: { label: "Gratitude", color: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400" },
  mood: { label: "Mood", color: "bg-pink-500/15 text-pink-600 dark:text-pink-400" },
};

interface Props {
  date: string;
  onClose: () => void;
}

export default function JournalPane(props: Props) {
  const [models] = createResource(fetchModels);
  const [questionsError, setQuestionsError] = createSignal<string | null>(null);
  const [streamingReflectionText, setStreamingReflectionText] = createSignal("");
  const [reflectionError, setReflectionError] = createSignal<string | null>(null);
  const [preferredModel, setPreferredModel] = createLocalStorageSignal<string | null>(
    "timeline:journal-model",
    null,
  );
  // Raw model response for debugging
  const [rawResponse, setRawResponse] = createSignal<string | null>(null);
  const [showDebug, setShowDebug] = createSignal(false);
  // Track which questions have expanded context (by index)
  const [expandedContext, setExpandedContext] = createSignal<Set<number>>(new Set());
  // Track which questions are being edited (by index)
  const [editingIndex, setEditingIndex] = createSignal<number | null>(null);
  // Track answer drafts by index
  const [drafts, setDrafts] = createSignal<Record<number, string>>({});
  const queryClient = useQueryClient();
  const saveAnswerMutation = useSaveJournalAnswer();
  const deleteManualEventMutation = useDeleteManualEvent();
  const saveReflectionMutation = useSaveJournalReflection();

  const selectedModel = () => {
    const m = models();
    if (!m || m.length === 0) return null;
    const pref = preferredModel();
    if (pref && m.some((opt) => opt.id === pref)) return pref;
    return m[0].id;
  };

  const journalStateQuery = useJournalState(() => props.date, selectedModel);
  const questions = () => journalStateQuery.data?.questions ?? [];
  const contextGroups = () => journalStateQuery.data?.contextGroups ?? {};

  let abortController: AbortController | null = null;

  const generateQuestionsMutation = createMutation(() => ({
    mutationFn: async ({ date, model, regenerate }: { date: string; model: string; regenerate: boolean }) => {
      abortController?.abort();
      abortController = new AbortController();
      const response = await fetch(`/api/journal/${date}/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, regenerate }),
        signal: abortController.signal,
        credentials: "include",
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Server error: ${response.status}${errText ? ` - ${errText}` : ""}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let metadataBuffer = "";
      let foundDelimiter = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const cleaned = chunk.replace(/\x01/g, "");
        if (!cleaned) continue;

        if (foundDelimiter) {
          metadataBuffer += cleaned;
          continue;
        }

        const delimiterIndex = cleaned.indexOf("\0");
        if (delimiterIndex === -1) {
          // Still streaming question text - ignore (we parse from metadata)
        } else {
          metadataBuffer = cleaned.slice(delimiterIndex + 1);
          foundDelimiter = true;
        }
      }

      const remaining = decoder.decode();
      if (remaining) metadataBuffer += remaining;

      if (!metadataBuffer) {
        throw new Error("Empty response from server");
      }

      const result = JSON.parse(metadataBuffer) as {
        rawResponse?: string;
        error?: string;
        details?: string;
        questions?: JournalQuestion[];
      };
      if (result.rawResponse) {
        setRawResponse(result.rawResponse);
      }
      if (result.error) {
        throw new Error(result.details ? `${result.error}: ${result.details}` : result.error);
      }

      // Now load the full state to get any existing answers + context events
      const state = await queryClient.fetchQuery({
        queryKey: queryKeys.journalState(date, model),
        queryFn: ({ signal }) => fetchJournalState(date, model, signal),
      });
      if (state.questions.length > 0 || !result.questions) return state;
      return { ...state, questions: result.questions };
    },
    onMutate: ({ regenerate }) => {
      setQuestionsError(null);
      if (regenerate) {
        setDrafts({});
        setEditingIndex(null);
      }
    },
    onSuccess: (state, { date, model }) => {
      queryClient.setQueryData(queryKeys.journalState(date, model), state);
    },
    onError: (e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setQuestionsError(e instanceof Error ? e.message : "Failed to generate questions");
    },
  }));

  const questionsLoading = () => generateQuestionsMutation.isPending;

  const generateQuestions = (regenerate = false) => {
    const model = selectedModel();
    if (!model) return;
    void generateQuestionsMutation.mutateAsync({ date: props.date, model, regenerate }).catch(() => undefined);
  };

  const saveAnswer = async (index: number) => {
    const q = questions()[index];
    if (!q) return;

    const draft = drafts()[index];
    if (!draft?.trim()) return;

    const model = selectedModel();
    const answer = draft.trim();
    const previousDrafts = drafts();
    const previousEditingIndex = editingIndex();

    setDrafts((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
    setEditingIndex(null);

    try {
      await saveAnswerMutation.mutateAsync({
        date: props.date,
        question: q.question,
        answer,
        questionIndex: index,
        questionCategory: q.category,
        model: model ?? undefined,
        groupIds: q.group_ids,
        eventId: q.event_id,
      });
    } catch (e) {
      setDrafts(previousDrafts);
      setEditingIndex(previousEditingIndex);
      alert(e instanceof Error ? e.message : "Failed to save answer");
    }
  };

  const deleteAnswer = async (index: number) => {
    const q = questions()[index];
    if (!q?.event_id) return;
    if (!confirm("Delete this answer?")) return;

    try {
      await deleteManualEventMutation.mutateAsync({
        id: q.event_id,
        date: props.date,
        journal: { date: props.date, model: selectedModel() ?? undefined, questionIndex: index },
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to delete answer");
    }
  };

  const generateReflectionMutation = createMutation(() => ({
    mutationFn: async ({ date, model }: { date: string; model: string }) => {
      const response = await fetch(`/api/journal/${date}/reflection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        credentials: "include",
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Server error: ${response.status}${errText ? ` - ${errText}` : ""}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let foundDelimiter = false;
      let metadataBuffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const cleaned = chunk.replace(/\x01/g, "");
        if (!cleaned) continue;

        if (foundDelimiter) {
          metadataBuffer += cleaned;
          continue;
        }

        const delimiterIndex = cleaned.indexOf("\0");
        if (delimiterIndex === -1) {
          fullText += cleaned;
          setStreamingReflectionText((prev) => prev + cleaned);
        } else {
          const textPart = cleaned.slice(0, delimiterIndex);
          if (textPart) {
            fullText += textPart;
            setStreamingReflectionText((prev) => prev + textPart);
          }
          metadataBuffer = cleaned.slice(delimiterIndex + 1);
          foundDelimiter = true;
        }
      }

      if (metadataBuffer) {
        const result = JSON.parse(metadataBuffer) as { error?: string; details?: string };
        if (result.error) {
          throw new Error(result.details ? `${result.error}: ${result.details}` : result.error);
        }
      }

      if (fullText.length > 0) {
        await saveReflectionMutation.mutateAsync({ date, answer: fullText, model });
      }
    },
    onMutate: () => {
      setReflectionError(null);
      setStreamingReflectionText("");
    },
    onSuccess: () => {
      setStreamingReflectionText("");
    },
    onError: (e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setReflectionError(e instanceof Error ? e.message : "Failed to generate reflection");
    },
  }));

  const reflectionLoading = () => generateReflectionMutation.isPending || saveReflectionMutation.isPending;

  const generateReflection = () => {
    const model = selectedModel();
    if (!model) return;
    void generateReflectionMutation.mutateAsync({ date: props.date, model }).catch(() => undefined);
  };

  // Reset transient UI state when date or model changes.
  createEffect(
    on(
      () => [props.date, selectedModel()] as const,
      () => {
        if (!selectedModel()) return;
        setExpandedContext(new Set<number>());
        setRawResponse(null);
        setShowDebug(false);
        setStreamingReflectionText("");
        setDrafts({});
        setEditingIndex(null);
        setQuestionsError(null);
        setReflectionError(null);
      },
    ),
  );

  onCleanup(() => {
    abortController?.abort();
  });

  const answeredCount = () => questions().filter((q) => q.answered).length;
  const hasQuestions = () => questions().length > 0;
  const reflectionText = () => {
    if (reflectionLoading()) return streamingReflectionText();
    return streamingReflectionText() || journalStateQuery.data?.reflection?.content || "";
  };

  return (
    <div class="h-full flex flex-col">
      {/* Header */}
      <div class="shrink-0 px-3 py-2 border-b border-border bg-card">
        <div class="flex items-center justify-between">
          <h2 class="font-medium text-foreground text-sm">Journal</h2>
          <button
            onClick={props.onClose}
            class="text-muted-foreground hover:text-foreground p-1 -mr-1"
            title="Close journal"
          >
            <IconClose class="w-4 h-4" />
          </button>
        </div>

        {/* Model selector + generate */}
        <Show
          when={!models.loading && (models() ?? []).length > 0}
          fallback={
            <Show when={!models.loading}>
              <p class="text-xs text-muted-foreground mt-2">AI models unavailable</p>
            </Show>
          }
        >
          <div class="flex items-center gap-2 mt-2">
            <select
              class="flex-1 text-xs bg-background border border-border rounded px-2 py-1"
              value={selectedModel() ?? ""}
              onChange={(e) => setPreferredModel(e.target.value)}
              disabled={questionsLoading()}
            >
              <For each={groupModelsByProvider(models() ?? [])}>
                {(group) => (
                  <optgroup label={group.provider}>
                    <For each={group.models}>
                      {(opt) => (
                        <option value={opt.id}>
                          {opt.name} ({opt.price} · {formatContextLength(opt.contextLength)})
                        </option>
                      )}
                    </For>
                  </optgroup>
                )}
              </For>
            </select>
            <button
              onClick={() => generateQuestions(hasQuestions())}
              disabled={questionsLoading() || !selectedModel()}
              class="text-xs text-muted-foreground enabled:hover:text-foreground px-2 py-1 rounded border border-border enabled:hover:bg-accent disabled:opacity-50 shrink-0"
              title={hasQuestions() ? "Regenerate questions" : "Generate questions"}
            >
              {questionsLoading()
                ? "Generating..."
                : hasQuestions()
                  ? "Regenerate"
                  : "Start Journal"}
            </button>
          </div>
        </Show>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-auto p-3 space-y-3">
        <Show when={questionsError()}>
          <p class="text-xs text-red-500">{questionsError()}</p>
        </Show>

        <Show when={questionsLoading() && !hasQuestions()}>
          <div class="text-sm text-muted-foreground animate-pulse">
            Generating questions from your day's events...
          </div>
        </Show>

        {/* Questions */}
        <For each={questions()}>
          {(q, index) => {
            const cat = () => CATEGORY_LABELS[q.category] ?? CATEGORY_LABELS.open;
            const isEditing = () => editingIndex() === index();
            const draft = () => drafts()[index()] ?? "";
            const citedGroups = () => {
              const ids = q.group_ids;
              if (!ids || ids.length === 0) return [];
              const groups = contextGroups();
              return ids.map((id) => groups[id]).filter(Boolean);
            };
            const hasContext = () => citedGroups().length > 0;
            const isContextExpanded = () => expandedContext().has(index());
            const toggleContext = () => {
              setExpandedContext((prev) => {
                const next = new Set(prev);
                if (next.has(index())) next.delete(index());
                else next.add(index());
                return next;
              });
            };

            return (
              <div class="border border-border rounded-sm p-3 space-y-2">
                {/* Category badge + context toggle */}
                <div class="flex items-center gap-2">
                  <span
                    class={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded ${cat().color}`}
                  >
                    {cat().label}
                  </span>
                  <Show when={hasContext()}>
                    <button
                      onClick={toggleContext}
                      class="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                      title="Show source context"
                    >
                      <IconChevronRight class={`w-3 h-3 transition-transform ${isContextExpanded() ? "rotate-90" : ""}`} />
                      {citedGroups().length} source{citedGroups().length !== 1 ? "s" : ""}
                    </button>
                  </Show>
                </div>

                {/* Context groups (collapsible) */}
                <Show when={isContextExpanded()}>
                  <div class="bg-muted/30 rounded px-2 py-1.5 space-y-1.5 text-xs text-muted-foreground border-l-2 border-border">
                    <For each={citedGroups()}>
                      {(group) => {
                        const timeRange = () => {
                          const s = group.timeRange.start;
                          const e = group.timeRange.end;
                          if (!s) return "";
                          const start = formatTime(s);
                          if (!e || s === e) return start;
                          const end = formatTime(e);
                          return `${start}–${end}`;
                        };
                        return (
                          <div>
                            <div class="flex gap-1.5 items-baseline">
                              <span class="text-muted-foreground/60 shrink-0 tabular-nums text-[10px]">{timeRange()}</span>
                              <span class="text-muted-foreground/80 font-medium">{sourceLabel(group.source)}: {group.label}</span>
                            </div>
                            <div class="text-[10px] text-muted-foreground/50 ml-[calc(0.375rem+4ch)]">
                              {group.summary}
                              <Show when={group.participants && group.participants.length > 0}>
                                {" — "}{group.participants?.join(", ")}
                              </Show>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>

                {/* Question */}
                <p class="text-sm text-foreground">{q.question}</p>

                {/* Answer area */}
                <Show
                  when={q.answered && !isEditing()}
                  fallback={
                    <div class="space-y-2">
                      <textarea
                        class="w-full text-sm bg-background border border-border rounded px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                        rows={3}
                        placeholder="Write your answer..."
                        value={draft()}
                        onInput={(e) =>
                          setDrafts((prev) => ({
                            ...prev,
                            [index()]: e.currentTarget.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            saveAnswer(index());
                          }
                        }}
                      />
                      <div class="flex gap-2">
                        <button
                          onClick={() => saveAnswer(index())}
                          disabled={!draft().trim() || saveAnswerMutation.isPending}
                          class="text-xs px-2 py-1 rounded bg-primary text-primary-foreground enabled:hover:bg-primary/90 disabled:opacity-50"
                        >
                          {saveAnswerMutation.isPending ? "Saving..." : "Save"}
                        </button>
                        <Show when={isEditing()}>
                          <button
                            onClick={() => {
                              setEditingIndex(null);
                              setDrafts((prev) => {
                                const next = { ...prev };
                                delete next[index()];
                                return next;
                              });
                            }}
                            class="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </Show>
                      </div>
                    </div>
                  }
                >
                  {/* Displayed answer */}
                  <div class="text-sm text-muted-foreground bg-muted/50 rounded px-2 py-1.5">
                    {q.answer}
                  </div>
                  <div class="flex gap-2">
                    <button
                      onClick={() => {
                        setEditingIndex(index());
                        setDrafts((prev) => ({ ...prev, [index()]: q.answer ?? "" }));
                      }}
                      class="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteAnswer(index())}
                      disabled={deleteManualEventMutation.isPending}
                      class="text-[11px] text-muted-foreground hover:text-red-500"
                    >
                      Delete
                    </button>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>

        {/* Reflection section */}
        <Show when={hasQuestions() && answeredCount() >= 1}>
          <div class="border-t border-border pt-3 mt-3 space-y-2">
            <Show
              when={reflectionText().length > 0}
              fallback={
                <button
                  onClick={generateReflection}
                  disabled={reflectionLoading() || answeredCount() === 0}
                  class="text-xs px-3 py-1.5 rounded border border-border text-muted-foreground enabled:hover:text-foreground enabled:hover:bg-accent disabled:opacity-50 w-full"
                >
                  {reflectionLoading()
                    ? "Writing reflection..."
                    : `Generate Reflection (${answeredCount()} answer${answeredCount() === 1 ? "" : "s"})`}
                </button>
              }
            >
              <h3 class="text-sm font-medium text-foreground">Reflection</h3>
              <div class="prose prose-sm dark:prose-invert max-w-none">
                <Markdown markdown={reflectionText()} />
              </div>
              <Show when={!reflectionLoading()}>
                <button
                  onClick={generateReflection}
                  class="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Regenerate
                </button>
              </Show>
            </Show>

            <Show when={reflectionError()}>
              <p class="text-xs text-red-500">{reflectionError()}</p>
            </Show>
          </div>
        </Show>

        {/* Empty state */}
        <Show when={!questionsLoading() && !hasQuestions() && !questionsError()}>
          <div class="text-center py-8 space-y-2">
            <p class="text-sm text-muted-foreground">
              Start journaling about your day
            </p>
            <p class="text-xs text-muted-foreground/70">
              AI will generate questions based on your day's events to help you reflect
            </p>
          </div>
        </Show>

        {/* Debug: raw model response */}
        <Show when={rawResponse()}>
          <div class="border-t border-border pt-2 mt-3">
            <button
              onClick={() => setShowDebug(!showDebug())}
              class="text-[10px] text-muted-foreground/50 hover:text-muted-foreground flex items-center gap-1"
            >
              <IconChevronRight class={`w-3 h-3 transition-transform ${showDebug() ? "rotate-90" : ""}`} />
              Raw model response
            </button>
            <Show when={showDebug()}>
              <pre class="mt-1 text-[10px] text-muted-foreground/60 bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                {rawResponse()}
              </pre>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
