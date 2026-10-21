import { A, useSearchParams } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { formatRelativeDate } from "../lib/format";
import { useConversationSources, useConversations } from "../lib/queries";
import { CONVERSATIONS_PAGE_SIZE } from "../lib/query-params";
import { normalizeRouteParam, routePageIndex } from "../lib/route-params";
import { buildConversationUrl } from "../lib/routes";
import { getSourceColorStyle } from "../lib/source-styles";
import { staleContentClass } from "../lib/stale-content";
import { IconStorage } from "../ui/icons";

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

export default function ConversationsListView() {
  const [searchParams, setSearchParams] = useSearchParams();

  const initialSearch = normalizeRouteParam(searchParams.search);
  const initialSource = normalizeRouteParam(searchParams.source);
  const initialPage = routePageIndex(searchParams.page);

  const [search, setSearch] = createSignal(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = createSignal(initialSearch);
  const [source, setSource] = createSignal(initialSource);
  const [page, setPage] = createSignal(initialPage);

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
  createEffect(on([debouncedSearch, source, page], ([s, src, p]) => {
    setSearchParams({
      search: s || undefined,
      source: src || undefined,
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

  const query = useConversations(() => ({
    search: debouncedSearch() || undefined,
    source: source() || undefined,
    limit: CONVERSATIONS_PAGE_SIZE,
    offset: page() * CONVERSATIONS_PAGE_SIZE,
  }));
  const sourceQuery = useConversationSources();

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
          placeholder="Search conversations..."
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
        <A
          href="/servers"
          class="flex items-center gap-1.5 px-3 py-2 rounded-sm border border-border bg-background text-sm hover:bg-accent transition-colors shrink-0"
          title="Browse Discord servers"
        >
          <IconStorage class="w-4 h-4" />
          <span class="hidden sm:inline">Servers</span>
        </A>
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
              <Show when={debouncedSearch() || source()}>
                {" "}matching filters
              </Show>
            </span>
          )}
        </Show>
        <Show when={sourceQuery.isLoadingError}>
          <span class="text-destructive">Failed to load conversation sources.</span>
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
