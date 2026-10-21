import { useNavigate, useSearchParams } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { fetchStats } from "../lib/api";
import {
  getSenderIdentifier,
  getSenderLabel,
  navigateToIdentity,
  resolveEventsIdentities,
} from "../lib/identities";
import { useContacts, useSearchEvents, useSemanticSearch } from "../lib/queries";
import {
  type AutocompleteSuggestion,
  applySuggestion,
  getAutocompleteSuggestions,
  getFilterChips,
  INVALID_CONTACT_FILTER_MESSAGE,
  parseContactFilterId,
  parseQuery,
  removeFilter,
} from "../lib/query-parser";
import { normalizeRouteParam } from "../lib/route-params";
import { buildCodingProjectUrl, buildConversationUrl, buildEventUrl, buildTimelineUrl } from "../lib/routes";
import { getSourceColorStyle } from "../lib/source-styles";
import { staleContentClass } from "../lib/stale-content";
import type { TimelineEvent } from "../lib/types";
import { IconClose, IconInfo, IconProgress } from "../ui/icons";
import SegmentedControl from "../ui/SegmentedControl";
import Avatar from "./Avatar";

const DEBOUNCE_MS = 300;

function formatTimestamp(ts: string | Date | null): string {
  if (!ts) return "—";
  const date = ts instanceof Date ? ts : new Date(ts);
  return date.toLocaleString();
}

function getSender(event: TimelineEvent): string | null {
  if (!event.type.startsWith("message")) return null;
  return getSenderLabel(event);
}

type SearchMode = "keyword" | "semantic";

const SEARCH_MODE_OPTIONS = [
  { value: "keyword", label: "Keyword" },
  { value: "semantic", label: "Semantic" },
] as const satisfies readonly { value: SearchMode; label: string }[];

type SearchEvent = TimelineEvent & { distance?: number };

function SearchResults(props: {
  mode: Accessor<SearchMode>;
  debouncedQuery: Accessor<string>;
  keywordQueryIsValid: Accessor<boolean>;
  searchQuery: ReturnType<typeof useSearchEvents>;
  semanticQuery: ReturnType<typeof useSemanticSearch>;
  children: (events: Accessor<SearchEvent[]>) => JSX.Element;
}) {
  const events = createMemo<SearchEvent[]>(() => {
    if (props.mode() === "semantic") {
      if (props.debouncedQuery().trim().length === 0 || props.semanticQuery.isError) {
        return [];
      }
      return props.semanticQuery.data?.events ?? [];
    }
    if (!props.keywordQueryIsValid()) return [];
    if (props.searchQuery.isError) return [];
    return props.searchQuery.data?.pages.flatMap((page) => page.events) ?? [];
  });

  createEffect(on(events, (loadedEvents) => {
    if (loadedEvents.length > 0) {
      resolveEventsIdentities(loadedEvents);
    }
  }));

  return props.children(events);
}

export default function SearchView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Search state - initialize from URL
  const initialQuery = normalizeRouteParam(searchParams.q);
  const [query, setQuery] = createSignal(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = createSignal(initialQuery);
  const mode = (): SearchMode =>
    normalizeRouteParam(searchParams.mode) === "semantic" ? "semantic" : "keyword";
  const [includeNoisySources, setIncludeNoisySources] = createSignal(false);
  const [cursorPosition, setCursorPosition] = createSignal(0);
  const [showAutocomplete, setShowAutocomplete] = createSignal(false);
  const [selectedSuggestion, setSelectedSuggestion] = createSignal(-1);

  let inputRef: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: IntersectionObserver | undefined;

  // Fetch stats for autocomplete suggestions
  const [stats] = createResource(() => fetchStats());
  const contactsQuery = useContacts(() => ({ includeHidden: true }));

  // Debounce the query for search. Semantic searches are submit-driven (Enter
  // or the Search button) instead: each one embeds the query server-side, so
  // firing per keystroke would queue slow embedding calls.
  createEffect(on(query, (q) => {
    clearTimeout(debounceTimer);
    if (mode() === "semantic") return;
    debounceTimer = setTimeout(() => {
      setDebouncedQuery(q);
    }, DEBOUNCE_MS);
  }));

  // Sync debounced query to URL
  createEffect(on(debouncedQuery, (q) => {
    const currentQ = normalizeRouteParam(searchParams.q);
    if (q !== currentQ) {
      setSearchParams({ q: q || undefined }, { replace: true });
    }
  }, { defer: true }));

  // Sync URL back to query (for browser back/forward)
  createEffect(on(() => searchParams.q, (urlQuery) => {
    const normalizedUrl = normalizeRouteParam(urlQuery);
    if (normalizedUrl !== query()) {
      setQuery(normalizedUrl);
      setDebouncedQuery(normalizedUrl);
    }
  }));

  onCleanup(() => {
    clearTimeout(debounceTimer);
    observer?.disconnect();
  });

  const parsedQuery = createMemo(() => parseQuery(query()));
  const debouncedParsedQuery = createMemo(() => parseQuery(debouncedQuery()));
  const settledContacts = () => contactsQuery.isLoading ? [] : (contactsQuery.data ?? []);
  const contactNames = createMemo(() => new Map(
    settledContacts().map((contact) => [contact.id, contact.display_name]),
  ));
  const filterChips = createMemo(() => getFilterChips(parsedQuery(), contactNames()));
  const contactFilterError = createMemo(() => {
    if (mode() !== "keyword") return null;
    const contact = parsedQuery().contact;
    if (contact === undefined || parseContactFilterId(contact) !== undefined) return null;
    return INVALID_CONTACT_FILTER_MESSAGE;
  });

  // Search query using TanStack Query's createInfiniteQuery
  const searchQuery = useSearchEvents(
    debouncedParsedQuery,
    () => {
      const contact = debouncedParsedQuery().contact;
      return mode() === "keyword" &&
        (contact === undefined || parseContactFilterId(contact) !== undefined);
    },
    () => includeNoisySources()
  );

  const semanticQuery = useSemanticSearch(
    () => ({ q: debouncedQuery().trim(), includeNoisySources: includeNoisySources() }),
    () => mode() === "semantic" && debouncedQuery().trim().length > 0
  );

  const isLoadingMore = () => mode() === "keyword" && searchQuery.isFetchingNextPage;
  const error = () => {
    const err = mode() === "semantic" ? semanticQuery.error : searchQuery.error;
    if (!err) return null;
    return err instanceof Error ? err.message : String(err);
  };
  const hasNextPage = () => mode() === "keyword" && searchQuery.hasNextPage;
  const searchResultsAreStale = () =>
    mode() === "semantic" ? semanticQuery.isPlaceholderData : searchQuery.isPlaceholderData;
  const semanticSearching = () => mode() === "semantic" && semanticQuery.isFetching;

  const loadMore = () => {
    if (searchQuery.hasNextPage && !searchQuery.isFetchingNextPage && !searchQuery.isPlaceholderData && !searchQuery.isFetching) {
      searchQuery.fetchNextPage();
    }
  };

  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage() && !isLoadingMore() && !searchResultsAreStale() && !searchQuery.isFetching) {
          loadMore();
        }
      },
      { rootMargin: "200px" }
    );
  });

  const setSentinelRef = (el: HTMLDivElement) => {
    if (observer) observer.observe(el);
  };

  const settledStats = () => {
    if (stats.state === "ready" || stats.state === "refreshing") {
      return stats.latest;
    }
    if (stats.state === "errored") throw stats.error;
    return undefined;
  };

  const availableSources = createMemo(() => {
    const s = settledStats();
    if (!s?.sources) return [];
    const sources = new Set<string>();
    for (const item of s.sources) {
      sources.add(item.source);
    }
    return Array.from(sources).sort();
  });

  const availableTypes = createMemo(() => {
    const s = settledStats();
    if (!s?.sources) return [];
    const types = new Set<string>();
    for (const item of s.sources) {
      types.add(item.type);
      const prefix = item.type.split(":")[0];
      if (prefix !== item.type) types.add(prefix);
    }
    return Array.from(types).sort();
  });

  const availableContacts = createMemo(() =>
    settledContacts()
      .filter((contact) => contact.hidden === 0)
      .map((contact) => ({
        id: contact.id,
        displayName: contact.display_name,
        eventCount: contact.eventCount,
        avatarUrl: contact.avatarUrl,
      }))
  );

  const suggestions = createMemo(() => {
    if (!showAutocomplete()) return [];
    return getAutocompleteSuggestions(
      query(),
      cursorPosition(),
      availableSources(),
      availableTypes(),
      availableContacts(),
    );
  });

  const LISTBOX_ID = "search-autocomplete-listbox";
  const optionId = (index: number) => `search-autocomplete-option-${index}`;

  // When the word at the cursor is `contact:<partial>`, return the partial
  // value (possibly "") so we can surface a dedicated loading/empty/error
  // state while contacts resolve. Returns null when not typing a contact.
  const activeContactPartial = createMemo<string | null>(() => {
    if (!showAutocomplete()) return null;
    const beforeCursor = query().slice(0, cursorPosition());
    const currentWord = beforeCursor.match(/(\S+)$/)?.[1] ?? "";
    const colonIndex = currentWord.indexOf(":");
    if (colonIndex === -1) return null;
    if (currentWord.slice(0, colonIndex).toLowerCase() !== "contact") return null;
    return currentWord.slice(colonIndex + 1);
  });

  const contactSuggestStatus = createMemo<"loading" | "error" | "empty" | "ready" | null>(() => {
    if (activeContactPartial() === null) return null;
    if (contactsQuery.isLoading) return "loading";
    if (contactsQuery.isError) return "error";
    if (suggestions().length === 0) return "empty";
    return "ready";
  });

  // Show the popover when we have suggestions, or when the user is typing a
  // contact and we owe them status feedback (loading / no matches / error).
  const showListbox = createMemo(() =>
    showAutocomplete() &&
    (suggestions().length > 0 ||
      (contactSuggestStatus() !== null && contactSuggestStatus() !== "ready"))
  );

  const activeDescendant = createMemo(() =>
    showListbox() &&
    selectedSuggestion() >= 0 &&
    selectedSuggestion() < suggestions().length
      ? optionId(selectedSuggestion())
      : undefined
  );

  const isInvalidContactChip = (key: string, value: string) =>
    key === "contact" && parseContactFilterId(value) === undefined;

  const setModeParam = (newMode: SearchMode) => {
    setShowAutocomplete(false);
    setSearchParams({ mode: newMode === "semantic" ? "semantic" : undefined });
  };

  const handleInput = (e: InputEvent) => {
    const input = e.currentTarget as HTMLInputElement;
    setQuery(input.value);
    setCursorPosition(input.selectionStart || 0);
    setShowAutocomplete(mode() === "keyword");
    setSelectedSuggestion(-1);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const suggs = suggestions();

    if (e.key === "Escape") {
      setShowAutocomplete(false);
      return;
    }

    if (e.key === "Enter") {
      setShowAutocomplete(false);
      const selected = suggs[selectedSuggestion()];
      if (selected) {
        e.preventDefault();
        selectSuggestion(selected);
      } else {
        clearTimeout(debounceTimer);
        setDebouncedQuery(query());
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestion((n) => Math.min(n + 1, suggs.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestion((n) => Math.max(n - 1, -1));
      return;
    }

    if (e.key === "Tab") {
      const selected = suggs[selectedSuggestion()];
      if (selected) {
        e.preventDefault();
        selectSuggestion(selected);
      } else {
        setShowAutocomplete(false);
      }
      return;
    }
  };

  const selectSuggestion = (suggestion: AutocompleteSuggestion) => {
    const { newQuery, newCursorPosition } = applySuggestion(
      query(),
      cursorPosition(),
      suggestion
    );
    setQuery(newQuery);
    setShowAutocomplete(false);
    setSelectedSuggestion(-1);

    requestAnimationFrame(() => {
      if (inputRef) {
        inputRef.focus();
        inputRef.setSelectionRange(newCursorPosition, newCursorPosition);
        setCursorPosition(newCursorPosition);
      }
    });
  };

  const handleRemoveChip = (filterKey: string, filterValue: string) => {
    const newQuery = removeFilter(query(), filterKey, filterValue);
    setQuery(newQuery);
    clearTimeout(debounceTimer);
    setDebouncedQuery(newQuery);
  };

  const syncCursorPosition = (input: HTMLInputElement) => {
    setSelectedSuggestion(-1);
    setCursorPosition(input.selectionStart ?? input.value.length);
  };

  const handleFocus = (e: FocusEvent) => {
    syncCursorPosition(e.currentTarget as HTMLInputElement);
    setShowAutocomplete(mode() === "keyword");
  };

  const handleBlur = (e: FocusEvent) => {
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    if (relatedTarget?.closest("[data-autocomplete]")) return;
    setShowAutocomplete(false);
  };

  const handleSearch = (e: Event) => {
    e.preventDefault();
    setShowAutocomplete(false);
    clearTimeout(debounceTimer);
    if (mode() === "keyword" && contactFilterError()) return;
    setDebouncedQuery(query());
  };

  const handlePersonClick = async (identifier: string, source: string, e: MouseEvent) => {
    e.stopPropagation();
    await navigateToIdentity(navigate, identifier, source);
  };

  return (
    <div class="h-full overflow-auto">
      <div class="max-w-6xl mx-auto px-4 py-6">
        {/* Search form */}
        <form onSubmit={handleSearch} class="mb-6 space-y-3">
          <div class="relative">
            <div class="flex flex-wrap gap-2 sm:flex-nowrap">
              <div class="relative w-full min-w-0 basis-full sm:w-auto sm:flex-1">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder={mode() === "semantic"
                    ? "Describe what you're looking for…"
                    : "Search... (try source:discord or contact:)"}
                  value={query()}
                  onInput={handleInput}
                  onKeyDown={handleKeyDown}
                  onFocus={handleFocus}
                  onClick={(e) => syncCursorPosition(e.currentTarget)}
                  onSelect={(e) => syncCursorPosition(e.currentTarget)}
                  onBlur={handleBlur}
                  role="combobox"
                  aria-label="Search timeline"
                  aria-autocomplete="list"
                  aria-expanded={showListbox()}
                  aria-controls={showListbox() ? LISTBOX_ID : undefined}
                  aria-activedescendant={activeDescendant()}
                  aria-invalid={contactFilterError() ? true : undefined}
                  aria-describedby={contactFilterError() ? "contact-filter-error" : undefined}
                  class={`w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 ${
                    contactFilterError()
                      ? "border-destructive focus:ring-destructive"
                      : "border-border focus:ring-ring"
                  }`}
                />

                <Show when={showListbox()}>
                  <ul
                    data-autocomplete
                    id={LISTBOX_ID}
                    role="listbox"
                    aria-label="Search suggestions"
                    class="absolute top-full left-0 right-0 z-50 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
                  >
                    <Show when={contactSuggestStatus() === "loading"}>
                      <li role="presentation">
                        <div
                          role="status"
                          aria-live="polite"
                          class="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
                        >
                          <IconProgress class="h-4 w-4 shrink-0 motion-safe:animate-spin" />
                          Loading contacts…
                        </div>
                      </li>
                    </Show>
                    <Show when={contactSuggestStatus() === "error"}>
                      <li role="presentation">
                        <div
                          role="alert"
                          class="flex items-center gap-2 px-3 py-2 text-sm text-destructive"
                        >
                          <IconInfo class="h-4 w-4 shrink-0" />
                          Couldn't load contacts — try again in a moment.
                        </div>
                      </li>
                    </Show>
                    <Show when={contactSuggestStatus() === "empty"}>
                      <li role="presentation">
                        <div
                          role="status"
                          aria-live="polite"
                          class="px-3 py-2 text-sm text-muted-foreground"
                        >
                          <Show
                            when={activeContactPartial()}
                            fallback="No contacts available yet."
                          >
                            {(partial) => (
                              <>
                                No contacts match "{partial()}". {INVALID_CONTACT_FILTER_MESSAGE}
                              </>
                            )}
                          </Show>
                        </div>
                      </li>
                    </Show>

                    <For each={suggestions()}>
                      {(suggestion, index) => (
                        <li role="presentation">
                          <button
                            type="button"
                            role="option"
                            id={optionId(index())}
                            aria-selected={index() === selectedSuggestion()}
                            tabIndex={-1}
                            class={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent ${
                              index() === selectedSuggestion() ? "bg-accent" : ""
                            }`}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              selectSuggestion(suggestion);
                            }}
                            onMouseEnter={() => setSelectedSuggestion(index())}
                          >
                            <Show
                              when={suggestion.contact}
                              fallback={
                                <span class="flex min-w-0 items-baseline gap-2">
                                  <span class="font-mono text-primary">{suggestion.value}</span>
                                  <span class="truncate text-muted-foreground">{suggestion.description}</span>
                                </span>
                              }
                            >
                              {(contact) => (
                                <>
                                  <Avatar
                                    url={contact().avatarUrl}
                                    name={contact().displayName}
                                    size="sm"
                                  />
                                  <span class="min-w-0 flex-1">
                                    <span class="block truncate font-medium text-foreground">
                                      {contact().displayName}
                                    </span>
                                    <span class="block truncate text-xs text-muted-foreground">
                                      {suggestion.description}
                                    </span>
                                  </span>
                                </>
                              )}
                            </Show>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>

              <SegmentedControl
                class="flex-1 sm:flex-none"
                fill
                label="Search mode"
                options={SEARCH_MODE_OPTIONS}
                value={mode()}
                onChange={setModeParam}
              />

              <button
                type="submit"
                class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Search
              </button>
            </div>
          </div>

          <Show when={contactFilterError()}>
            <p
              id="contact-filter-error"
              role="alert"
              class="flex items-start gap-1.5 text-xs text-destructive"
            >
              <IconInfo class="mt-px h-3.5 w-3.5 shrink-0" />
              <span>{contactFilterError()}</span>
            </p>
          </Show>

          <Show when={mode() === "keyword" && filterChips().length > 0}>
            <div class="flex flex-wrap gap-2">
              <For each={filterChips()}>
                {(chip) => {
                  const invalid = () => isInvalidContactChip(chip.key, chip.value);
                  return (
                    <span
                      class={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium ${
                        invalid()
                          ? "border border-dashed border-destructive bg-transparent text-destructive"
                          : "bg-secondary text-secondary-foreground"
                      }`}
                    >
                      <Show when={invalid()}>
                        <IconInfo class="h-3 w-3 shrink-0" aria-hidden="true" />
                      </Show>
                      <span class="max-w-[16rem] truncate">{chip.label}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${chip.label} filter`}
                        title={`Remove ${chip.label} filter`}
                        onClick={() => handleRemoveChip(chip.key, chip.value)}
                        class="ml-1 rounded-full p-0.5 hover:bg-accent"
                      >
                        <IconClose class="h-3 w-3" aria-hidden="true" />
                      </button>
                    </span>
                  );
                }}
              </For>
            </div>
          </Show>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <Show
              when={mode() === "keyword"}
              fallback={
                <p class="text-xs text-muted-foreground">
                  Matches by meaning, not keywords — press Enter to search. Results ranked closest first.
                </p>
              }
            >
              <p class="text-xs text-muted-foreground">
                Filters: <code class="bg-secondary px-1 rounded">source:</code>{" "}
                <code class="bg-secondary px-1 rounded">type:</code>{" "}
                <code class="bg-secondary px-1 rounded">date:</code>{" "}
                <code class="bg-secondary px-1 rounded">after:</code>{" "}
                <code class="bg-secondary px-1 rounded">before:</code>{" "}
                <code class="bg-secondary px-1 rounded">at:</code>{" "}
                <code class="bg-secondary px-1 rounded">contact:</code>{" "}
                <code class="bg-secondary px-1 rounded">chat:</code>
              </p>
            </Show>
            <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={includeNoisySources()}
                onChange={(e) => setIncludeNoisySources(e.currentTarget.checked)}
              />
              Include agent &amp; screen-recall sources
            </label>
          </div>
        </form>

        {/* Results */}
        <Suspense
          fallback={
            <div class="text-center py-8 text-muted-foreground">
              Loading results...
            </div>
          }
        >
          <SearchResults
            mode={mode}
            debouncedQuery={debouncedQuery}
            keywordQueryIsValid={() => contactFilterError() === null}
            searchQuery={searchQuery}
            semanticQuery={semanticQuery}
          >
            {(events) => (
              <div class="space-y-2">
          <Show when={error()}>
            <div class="text-center py-8 text-red-500">Error: {error()}</div>
          </Show>

          <Show when={events().length > 0}>
            <div class={staleContentClass(searchResultsAreStale())} aria-busy={searchResultsAreStale()}>
            <p class="text-sm text-muted-foreground mb-4">
              <Show
                when={mode() === "keyword"}
                fallback={<><span class="font-mono">{events().length}</span> nearest events</>}
              >
                <span class="font-mono">{events().length}</span> events loaded
                <Show when={hasNextPage()}>
                  <span class="ml-1">(scroll for more)</span>
                </Show>
              </Show>
            </p>

            <div class="space-y-1">
              <For each={events()}>
                {(event) => {
                  const isMessage = event.type.startsWith("message");
                  const isWakaTime = event.source === "wakatime" && event.type === "code:session";
                  return (
                    <div
                      class="rounded-lg bg-card p-3 transition-colors hover:bg-accent/50"
                    >
                      <div class="flex items-start gap-3">
                        <div class="flex flex-col gap-1 shrink-0">
                          <span
                            class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium source-badge"
                            style={getSourceColorStyle(event.source)}
                          >
                            {sourceLabel(event.source)}
                          </span>
                          <span class="text-xs text-muted-foreground">{event.type}</span>
                        </div>

                        <div class="flex-1 min-w-0">
                          <Show when={event.title}>
                            {(title) => (
                              <a
                                class="block font-medium truncate hover:underline text-left"
                                classList={{
                                  "hover:text-purple-400": isWakaTime,
                                  "hover:text-primary": !isWakaTime,
                                }}
                                href={isMessage && event.conversation_id
                                  ? buildConversationUrl(event.source, event.conversation_id, event.id)
                                  : isWakaTime
                                    ? buildCodingProjectUrl(title().match(/^(.+?)\s*\(/)?.[1] || title())
                                    : buildEventUrl(event.id)}
                              >
                                {title()}
                              </a>
                            )}
                          </Show>
                          <Show when={getSender(event)}>
                            {(senderName) => {
                              const identifier = getSenderIdentifier(event);
                              return (
                                <button
                                  class="text-xs text-muted-foreground hover:text-primary hover:underline"
                                  onClick={(e) => identifier && handlePersonClick(identifier, event.source, e)}
                                >
                                  &lt;{senderName()}&gt;
                                </button>
                              );
                            }}
                          </Show>
                          <Show when={event.content && event.content !== event.title}>
                            <p class="text-sm text-muted-foreground line-clamp-2">{event.content}</p>
                          </Show>
                          <Show when={event.location_name}>
                            <p class="text-xs text-muted-foreground mt-1">@ {event.location_name}</p>
                          </Show>
                        </div>

                        <div class="flex flex-col items-end gap-1 shrink-0">
                          <div class="text-xs text-muted-foreground font-mono">
                            {formatTimestamp(event.timestamp)}
                          </div>
                          <Show when={mode() === "semantic" ? event.distance : undefined}>
                            {(distance) => (
                              <span
                                class="text-xs font-mono text-muted-foreground"
                                title="Vector distance (lower is closer)"
                              >
                                {distance().toFixed(3)}
                              </span>
                            )}
                          </Show>
                          <Show when={event.timestamp}>
                            {(timestamp) => (
                              <a
                                class="text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent"
                                href={buildTimelineUrl({
                                  date: new Date(timestamp()).toISOString().split("T")[0],
                                  eventId: event.id,
                                })}
                                title="View this day"
                              >
                                this day
                              </a>
                            )}
                          </Show>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>

            <Show when={mode() === "keyword"}>
              <div ref={setSentinelRef} class="h-4" />
            </Show>

            <Show when={isLoadingMore()}>
              <div class="text-center py-4 text-muted-foreground">Loading more...</div>
            </Show>

            <Show when={mode() === "keyword" && !hasNextPage() && !isLoadingMore()}>
              <div class="text-center py-4 text-muted-foreground text-sm">End of results</div>
            </Show>
            </div>
          </Show>

          <Show when={events().length === 0 && !error() && semanticSearching()}>
            <div class="text-center py-8 text-muted-foreground">Searching by meaning…</div>
          </Show>

          <Show when={events().length === 0 && !error() && !semanticSearching() && !contactFilterError()}>
            <Show
              when={mode() === "semantic" && debouncedQuery().trim().length === 0}
              fallback={
                <div class={`text-center py-8 text-muted-foreground ${staleContentClass(searchResultsAreStale())}`} aria-busy={searchResultsAreStale()}>No events found</div>
              }
            >
              <div class="text-center py-8 text-muted-foreground">
                Describe a moment, topic, or feeling — then press Enter
              </div>
            </Show>
          </Show>
              </div>
            )}
          </SearchResults>
        </Suspense>
      </div>
    </div>
  );
}
