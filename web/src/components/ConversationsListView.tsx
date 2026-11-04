import { A, Navigate, useSearchParams } from "@solidjs/router";
import { CHAT_ASSISTANT_SOURCES, CODING_AGENT_SOURCES } from "@shared/grouping";
import { sourceLabel } from "@shared/sources";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { ConversationListItem } from "../lib/api";
import { formatRelativeDate } from "../lib/format";
import {
  useCodingAgentConversationFilters,
  useCodingAgentConversations,
  useConversationSources,
  useConversations,
} from "../lib/queries";
import { CONVERSATIONS_PAGE_SIZE } from "../lib/query-params";
import { normalizeRouteParam, routePageIndex } from "../lib/route-params";
import {
  buildAiChatsUrl,
  buildCodingConversationsUrl,
  buildConversationUrl,
  ROUTES,
} from "../lib/routes";
import { getSourceColorStyle } from "../lib/source-styles";
import { staleContentClass } from "../lib/stale-content";
import { IconChevronLeft, IconStorage } from "../ui/icons";

const DEBOUNCE_MS = 300;

function ConversationsSkeleton() {
  return (
    <div role="status" aria-label="Loading conversations" class="divide-y divide-border/50">
      <span class="sr-only">Loading conversations...</span>
      <For each={[1, 2, 3, 4, 5, 6]}>
        {() => (
          <div class="flex items-center gap-2 px-4 py-3">
            <div class="h-5 w-14 rounded bg-accent animate-pulse shrink-0" />
            <div class="h-4 max-w-80 flex-1 rounded bg-accent animate-pulse" />
            <div class="h-4 w-8 rounded bg-accent animate-pulse shrink-0" />
            <div class="h-4 w-20 rounded bg-accent animate-pulse shrink-0" />
          </div>
        )}
      </For>
    </div>
  );
}

/**
 * Which conversations a list shows: people (`messages`), coding-agent sessions
 * with their project (`coding`), or chat assistants (`assistants`).
 */
export type ConversationListScope = "messages" | "coding" | "assistants";

const SEARCH_PLACEHOLDERS: Record<ConversationListScope, string> = {
  messages: "Search conversations...",
  coding: "Search coding agent sessions...",
  assistants: "Search AI chats...",
};

// Project <select> values. A prefix keeps a project literally named
// "unassigned" distinct from the no-project bucket.
const UNASSIGNED_OPTION = "unassigned";
const PROJECT_OPTION_PREFIX = "project:";

function rowProject(conversation: ConversationListItem): string | null {
  return "project" in conversation && typeof conversation.project === "string"
    ? conversation.project
    : null;
}

function ConversationListView(props: { scope: ConversationListScope }) {
  const [searchParams, setSearchParams] = useSearchParams();

  const initialSearch = normalizeRouteParam(searchParams.search);
  const initialSource = normalizeRouteParam(searchParams.source);
  const initialPage = routePageIndex(searchParams.page);

  const [search, setSearch] = createSignal(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = createSignal(initialSearch);
  const [source, setSource] = createSignal(initialSource);
  const [page, setPage] = createSignal(initialPage);
  const [project, setProject] = createSignal(normalizeRouteParam(searchParams.project));
  const [unassigned, setUnassigned] = createSignal(normalizeRouteParam(searchParams.unassigned) === "1");

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Debounce search input (defer: skip initial value, only react to user changes)
  createEffect(on(search, (q) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (q !== debouncedSearch()) {
        setDebouncedSearch(q);
        setPage(0);
      }
    }, DEBOUNCE_MS);
  }, { defer: true }));

  // Sync state to URL
  createEffect(on([debouncedSearch, source, page, project, unassigned], ([s, src, p, proj, none]) => {
    setSearchParams({
      search: s || undefined,
      source: src || undefined,
      project: proj || undefined,
      unassigned: none ? "1" : undefined,
      page: p > 0 ? String(p + 1) : undefined,
    }, { replace: true });
  }, { defer: true }));

  // Sync URL back (browser back/forward)
  createEffect(on(() => searchParams.search, (urlSearch) => {
    const val = normalizeRouteParam(urlSearch);
    if (val !== search()) {
      setSearch(val);
      setDebouncedSearch(val);
    }
  }));
  createEffect(on(() => searchParams.source, (urlSource) => {
    const val = normalizeRouteParam(urlSource);
    if (val !== source()) setSource(val);
  }));
  createEffect(on(() => searchParams.project, (urlProject) => {
    const val = normalizeRouteParam(urlProject);
    if (val !== project()) setProject(val);
  }));
  createEffect(on(() => searchParams.unassigned, (urlUnassigned) => {
    const val = normalizeRouteParam(urlUnassigned) === "1";
    if (val !== unassigned()) setUnassigned(val);
  }));
  createEffect(on(() => searchParams.page, (urlPage) => {
    const val = routePageIndex(urlPage);
    if (val !== page()) setPage(val);
  }));

  // Keyboard shortcuts for pagination
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "ArrowLeft" && page() > 0) {
      setPage((p) => p - 1);
    } else if (e.key === "ArrowRight" && page() + 1 < totalPages()) {
      setPage((p) => p + 1);
    }
  };

  onMount(() => document.addEventListener("keydown", handleKeydown));
  onCleanup(() => {
    clearTimeout(debounceTimer);
    document.removeEventListener("keydown", handleKeydown);
  });

  const listParams = () => ({
    search: debouncedSearch() || undefined,
    source: source() || undefined,
    limit: CONVERSATIONS_PAGE_SIZE,
    offset: page() * CONVERSATIONS_PAGE_SIZE,
  });
  // The scope is fixed per route, so each list creates only the queries it uses.
  const query = props.scope === "coding"
    ? useCodingAgentConversations(() => ({
        ...listParams(),
        project: project() || undefined,
        unassigned: unassigned() || undefined,
      }))
    : useConversations(() => ({
        scope: props.scope === "assistants" ? "assistants" : "messages",
        ...listParams(),
      }));
  const filtersQuery = props.scope === "coding" ? useCodingAgentConversationFilters() : null;
  const sourceQuery = filtersQuery
    ?? useConversationSources(() => (props.scope === "assistants" ? "assistants" : "messages"));

  const projectFilters = () =>
    !filtersQuery || filtersQuery.isPending || filtersQuery.isLoadingError ? null : filtersQuery.data ?? null;
  const projectValue = () =>
    unassigned() ? UNASSIGNED_OPTION : project() ? `${PROJECT_OPTION_PREFIX}${project()}` : "";
  // Options are keyed by name (strings), so the selected <option> survives the
  // filter counts loading and the <select> keeps its value.
  const projectCounts = () =>
    new Map((projectFilters()?.projects ?? []).map((p) => [p.name, p.count]));
  const projectCountLabel = (name: string) => {
    const count = projectCounts().get(name);
    return count === undefined ? "" : ` (${count.toLocaleString()})`;
  };
  const projectOptions = () => {
    const loaded = [...projectCounts().keys()];
    const selected = project();
    return selected && !loaded.includes(selected) ? [selected, ...loaded] : loaded;
  };
  const selectProject = (value: string) => {
    setUnassigned(value === UNASSIGNED_OPTION);
    setProject(value.startsWith(PROJECT_OPTION_PREFIX) ? value.slice(PROJECT_OPTION_PREFIX.length) : "");
    setPage(0);
  };

  // Query data is a Solid resource accessor. Reading it while the first request
  // is pending activates the route's Suspense boundary, so only expose it once
  // the query has settled. Placeholder data remains available during filter and
  // pagination transitions because those queries have a successful status.
  const conversationData = () =>
    query.isPending || query.isLoadingError ? null : query.data;
  const sources = () =>
    sourceQuery.isPending || sourceQuery.isLoadingError
      ? null
      : sourceQuery.data?.sources ?? [];
  const sourceOptions = () => {
    const loadedSources = sources() ?? [];
    const selectedSource = source();
    return selectedSource && !loadedSources.includes(selectedSource)
      ? [selectedSource, ...loadedSources]
      : loadedSources;
  };
  const totalPages = () =>
    Math.ceil((conversationData()?.total ?? 0) / CONVERSATIONS_PAGE_SIZE);
  const conversationsAreStale = () => query.isPlaceholderData;

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="flex items-center gap-3 px-4 py-3 border-b border-border">
        <input
          type="text"
          placeholder={SEARCH_PLACEHOLDERS[props.scope]}
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          class="flex-1 px-3 py-2 rounded-sm border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <select
          value={source()}
          onChange={(e) => { setSource(e.currentTarget.value); setPage(0); }}
          aria-label="Conversation source"
          class="px-3 py-2 rounded-sm border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="">
            {sourceQuery.isPending
              ? "Loading sources..."
              : sourceQuery.isLoadingError
                ? "Sources unavailable"
                : "All sources"}
          </option>
          <For each={sourceOptions()}>
            {(s) => <option value={s}>{sourceLabel(s)}</option>}
          </For>
        </select>
        <Show when={props.scope === "coding"}>
          <select
            value={projectValue()}
            onChange={(e) => selectProject(e.currentTarget.value)}
            aria-label="Coding project"
            class="px-3 py-2 rounded-sm border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary max-w-56"
          >
            <option value="">
              {filtersQuery?.isPending
                ? "Loading projects..."
                : filtersQuery?.isLoadingError
                  ? "Projects unavailable"
                  : "All projects"}
            </option>
            <option value={UNASSIGNED_OPTION}>
              No project{projectFilters() ? ` (${projectFilters()?.unassigned.toLocaleString()})` : ""}
            </option>
            <For each={projectOptions()}>
              {(name) => (
                <option value={`${PROJECT_OPTION_PREFIX}${name}`}>
                  {name}{projectCountLabel(name)}
                </option>
              )}
            </For>
          </select>
        </Show>
        <Show when={props.scope === "messages"}>
          <A
            href="/servers"
            class="flex items-center gap-1.5 px-3 py-2 rounded-sm border border-border bg-background text-sm hover:bg-accent transition-colors shrink-0"
            title="Browse Discord servers"
          >
            <IconStorage class="w-4 h-4" />
            <span class="hidden sm:inline">Servers</span>
          </A>
        </Show>
      </div>

      {/* Results info */}
      <div class={`flex items-center justify-between gap-3 px-4 py-2 text-sm text-muted-foreground border-b border-border ${staleContentClass(conversationsAreStale())}`} aria-busy={conversationsAreStale()}>
        <Show
          when={conversationData()}
          fallback={
            <Show when={!query.isLoadingError}>
              <div class="h-4 w-32 rounded bg-accent animate-pulse" />
            </Show>
          }
        >
          {(data) => (
            <span>
              <span class="font-mono">{data().total.toLocaleString()}</span> conversation{data().total !== 1 ? "s" : ""}
              <Show when={debouncedSearch() || source() || project() || unassigned()}>
                {" "}matching filters
              </Show>
            </span>
          )}
        </Show>
        <Show when={sourceQuery.isLoadingError}>
          <span class="text-destructive">
            {props.scope === "coding" ? "Failed to load filters." : "Failed to load conversation sources."}
          </span>
        </Show>
      </div>

      {/* Conversation list */}
      <div class={`flex-1 overflow-y-auto ${staleContentClass(conversationsAreStale())}`} aria-busy={conversationsAreStale()}>
        <Show
          when={conversationData()}
          fallback={
            <Show
              when={query.isLoadingError}
              fallback={<ConversationsSkeleton />}
            >
              <div class="px-4 py-12 text-center text-destructive text-sm">
                Failed to load conversations.
              </div>
            </Show>
          }
        >
          {(data) => (
            <Show
              when={data().conversations.length > 0}
              fallback={
                <div class="px-4 py-8 text-center text-muted-foreground text-sm">
                  No conversations found.
                </div>
              }
            >
              <For each={data().conversations}>
                {(conv) => (
                  <a
                    href={buildConversationUrl(conv.source, conv.conversationId)}
                    class="flex items-center gap-2 px-4 py-3 border-b border-border hover:bg-accent transition-colors"
                  >
                    <span
                      class="text-xs px-1.5 py-0.5 rounded source-badge shrink-0"
                      style={getSourceColorStyle(conv.source)}
                    >
                      {sourceLabel(conv.source)}
                    </span>
                    <span class="truncate flex-1 text-sm">{conv.title}</span>
                    <Show when={rowProject(conv)}>
                      {(name) => (
                        <span class="text-xs text-muted-foreground truncate max-w-40 shrink-0">{name()}</span>
                      )}
                    </Show>
                    <span class="text-sm text-muted-foreground font-mono tabular-nums shrink-0">
                      {conv.messageCount.toLocaleString()}
                    </span>
                    <span class="text-sm text-muted-foreground shrink-0 w-20 text-right font-mono">
                      {formatRelativeDate(conv.lastMessage)}
                    </span>
                  </a>
                )}
              </For>
            </Show>
          )}
        </Show>
      </div>

      {/* Pagination */}
      <Show when={totalPages() > 1}>
        <div class={`flex items-center justify-between px-4 py-2 border-t border-border text-sm ${staleContentClass(conversationsAreStale())}`} aria-busy={conversationsAreStale()}>
          <button
            disabled={page() === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            class="px-3 py-1.5 rounded-sm border border-border bg-background enabled:hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <span class="text-sm text-muted-foreground font-mono tabular-nums">
            Page {page() + 1} of {totalPages()}
          </span>
          <button
            disabled={page() + 1 >= totalPages()}
            onClick={() => setPage((p) => p + 1)}
            class="px-3 py-1.5 rounded-sm border border-border bg-background enabled:hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </Show>
    </div>
  );
}

function scopeForSource(source: string): Exclude<ConversationListScope, "messages"> | null {
  if ((CODING_AGENT_SOURCES as readonly string[]).includes(source)) return "coding";
  if ((CHAT_ASSISTANT_SOURCES as readonly string[]).includes(source)) return "assistants";
  return null;
}

/**
 * Messages: conversations with people. Old links filtered to an AI source
 * (`/conversations?source=codex`) redirect to the page that now lists it.
 */
export default function ConversationsListView() {
  const [searchParams] = useSearchParams();
  const redirect = () => {
    const source = normalizeRouteParam(searchParams.source);
    const search = normalizeRouteParam(searchParams.search) || undefined;
    switch (scopeForSource(source)) {
      case "coding":
        return buildCodingConversationsUrl({ source, search });
      case "assistants":
        return buildAiChatsUrl({ source, search });
      default:
        return null;
    }
  };
  return (
    <Show when={redirect()} fallback={<ConversationListView scope="messages" />}>
      {(href) => <Navigate href={href()} />}
    </Show>
  );
}

/** Coding-agent sessions with their project, under the Coding page. */
export function CodingConversationsListView() {
  return (
    <div class="flex flex-col h-full">
      <div class="flex items-center gap-2 px-4 pt-3">
        <A href={ROUTES.CODING} class="p-1 rounded-sm hover:bg-accent text-muted-foreground" title="Back to Coding">
          <IconChevronLeft class="w-5 h-5" />
        </A>
        <h1 class="font-display text-lg font-medium">Coding agent sessions</h1>
      </div>
      <div class="flex-1 min-h-0">
        <ConversationListView scope="coding" />
      </div>
    </div>
  );
}

/** General-purpose chat assistant conversations (claude.ai, ChatGPT, ...). */
export function AiChatsListView() {
  return <ConversationListView scope="assistants" />;
}
