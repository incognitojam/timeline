import { useNavigate, useSearchParams } from "@solidjs/router";
import { sourceLabel } from "@shared/sources";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { clearCache, formatIdentifier, getAvatarUrl, getDisplayName, invalidateCache, isQualifiedIdentifier, resolveIdentifiers } from "../lib/identities";
import {
  useBatchLinkIdentities,
  useContact,
  useContactEvents,
  useContactSuggestions,
  useContacts,
  useCreateContact,
  useCreateContactMemory,
  useDeleteContact,
  useDeleteContactMemory,

  useIdentityEvents,
  useLinkIdentity,
  useLinkSuggestions,
  useRefreshCache,
  useSkipIdentity,
  useSkippedIdentities,
  useSuggestedContactsForIdentity,
  useUnlinkedIdentities,
  useUnlinkIdentity,
  useUnskipIdentity,
  useUpdateContact,
} from "../lib/queries";
import { buildConversationUrl } from "../lib/routes";
import { normalizeRouteParam } from "../lib/route-params";
import { getSourceColorStyle } from "../lib/source-styles";
import { staleContentClass } from "../lib/stale-content";
import type { Contact, ContactIdentity, ContactMemory as ContactMemoryType, ContactWithStats, UnlinkedIdentity } from "../lib/types";
import Avatar from "./Avatar";
import ContactConversations from "./ContactConversations";
import ContactSpotifySummary from "./ContactSpotifySummary";
import { IconBolt, IconCheck, IconChevronRight, IconClose, IconEdit, IconProgress, IconRefresh } from "../ui/icons";

// Virtual scrolling constants for suggestions list
const SUGGESTION_ROW_HEIGHT = 100; // Approximate height per identity item
const SUGGESTION_OVERSCAN = 3;

const SEARCH_DEBOUNCE_MS = 300;

function YouBadge(props: { ariaHidden?: boolean }) {
  return (
    <span
      aria-hidden={props.ariaHidden || undefined}
      class="text-xs font-sans font-medium border border-primary/50 text-primary rounded-sm px-1.5 py-0.5"
    >
      You
    </span>
  );
}

export default function ContactsView() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive contact selection directly from URL (URL is the source of truth)
  const selectedContactId = (): number | undefined => {
    const id = normalizeRouteParam(searchParams.id);
    return id ? parseInt(id, 10) : undefined;
  };

  // Derive unlinked identity selection from URL
  const selectedUnlinked = (): { identifier: string; source: string } | null => {
    const unlinked = normalizeRouteParam(searchParams.unlinked);
    const source = normalizeRouteParam(searchParams.source);
    return unlinked && source ? { identifier: unlinked, source } : null;
  };

  const initialViewMode = (): "contacts" | "unlinked" | "skipped" => {
    const view = normalizeRouteParam(searchParams.view);
    if (view === "unlinked" || view === "skipped") return view;
    // Auto-switch to unlinked view if an unlinked identity is selected
    if (normalizeRouteParam(searchParams.unlinked)) return "unlinked";
    return "contacts";
  };

  const initialSearch = () => normalizeRouteParam(searchParams.search);

  // Navigation helpers
  const navigateToSearch = (query: string) => {
    navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  const openConversation = (source: string, conversationId: string, eventId?: number) => {
    navigate(buildConversationUrl(source, conversationId, eventId));
  };

  const openUnlinkedIdentity = (identifier: string, platform: string) => {
    setSearchParams({
      view: "unlinked",
      id: undefined,
      unlinked: identifier,
      source: platform,
    }, { replace: true });
  };

  // UI state - initialized from URL
  const [viewMode, setViewModeInternal] = createSignal<"contacts" | "unlinked" | "skipped">(initialViewMode());
  const [searchQuery, setSearchQuery] = createSignal(initialSearch());
  const [debouncedSearchQuery, setDebouncedSearchQuery] = createSignal(initialSearch());

  let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Debounce search for URL sync
  createEffect(on(searchQuery, (q) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      setDebouncedSearchQuery(q);
    }, SEARCH_DEBOUNCE_MS);
  }));

  // Sync debounced search to URL
  createEffect(on(debouncedSearchQuery, (q) => {
    const currentSearch = normalizeRouteParam(searchParams.search);
    if (q !== currentSearch) {
      setSearchParams({ search: q || undefined }, { replace: true });
    }
  }, { defer: true }));

  // Sync URL back to search (for browser back/forward)
  createEffect(on(() => searchParams.search, (urlSearch) => {
    const normalized = normalizeRouteParam(urlSearch);
    if (normalized !== searchQuery()) {
      setSearchQuery(normalized);
      setDebouncedSearchQuery(normalized);
    }
  }));

  // Sync URL back to viewMode (for browser back/forward)
  createEffect(on(() => [searchParams.view, searchParams.unlinked] as const, ([urlView, urlUnlinked]) => {
    const normalized = normalizeRouteParam(urlView);
    let mode: "contacts" | "unlinked" | "skipped";
    if (normalized === "unlinked" || normalized === "skipped") {
      mode = normalized;
    } else if (normalizeRouteParam(urlUnlinked)) {
      // Auto-switch to unlinked view if an unlinked identity is selected
      mode = "unlinked";
    } else {
      mode = "contacts";
    }
    if (mode !== viewMode()) {
      setViewModeInternal(mode);
    }
  }));

  // Wrapper to sync viewMode changes to URL
  const setViewMode = (mode: "contacts" | "unlinked" | "skipped") => {
    setViewModeInternal(mode);
    // When switching to contacts, also clear the unlinked identity selection
    if (mode === "contacts") {
      setSearchParams({ view: undefined, unlinked: undefined, source: undefined }, { replace: true });
    } else {
      setSearchParams({ view: mode }, { replace: true });
    }
  };
  const [showHidden, setShowHidden] = createSignal(false);
  const [editingContact, setEditingContact] = createSignal<Contact | null>(null);
  const QUALIFIED_IDENTITY_MESSAGE = "Identity must be fully-qualified (platform:id or platform:name:Display Name).";
  const [showCreateForm, setShowCreateForm] = createSignal(false);
  const [newContactName, setNewContactName] = createSignal("");
  const [newContactNotes, setNewContactNotes] = createSignal("");
  const [showLinkModal, setShowLinkModal] = createSignal(false);
  const [selectedIdentity, setSelectedIdentity] = createSignal<UnlinkedIdentity | null>(null);
  const [linkSearch, setLinkSearch] = createSignal("");
  const [suggestionsSort, setSuggestionsSort] = createSignal<"desc" | "asc">("desc");
  const [suggestionsSource, setSuggestionsSource] = createSignal<string>("");
  const [batchLinkingContact, setBatchLinkingContact] = createSignal<number | null>(null);
  const [contactUpdateError, setContactUpdateError] = createSignal<string | null>(null);


  // Virtual scrolling state for suggestions list
  const [suggestionsScrollTop, setSuggestionsScrollTop] = createSignal(0);
  const [suggestionsContainerHeight, setSuggestionsContainerHeight] = createSignal(400);
  let suggestionsResizeObserver: ResizeObserver | undefined;

  // Query hooks - data fetching with caching
  const contactsQuery = useContacts(() => ({
    includeHidden: showHidden(),
  }));
  const unlinkedQuery = useUnlinkedIdentities();
  const skippedQuery = useSkippedIdentities();
  const selectedContactQuery = useContact(() => selectedContactId());
  const contactEventsQuery = useContactEvents(() => selectedContactId(), () => ({ limit: 20 }));
  const contactSuggestionsQuery = useContactSuggestions(() => selectedContactId());

  // Identity events for unlinked identity detail panel
  const identityEventsQuery = useIdentityEvents(
    () => {
      const u = selectedUnlinked();
      return u ? { identifier: u.identifier, platform: u.source } : undefined;
    },
    () => ({ limit: 20 })
  );
  const suggestedContactsQuery = useSuggestedContactsForIdentity(
    () => selectedIdentity()?.identifier
  );
  const linkSuggestionsQuery = useLinkSuggestions();

  // Mutation hooks
  const createContactMutation = useCreateContact();
  const updateContactMutation = useUpdateContact();
  const deleteContactMutation = useDeleteContact();
  const createMemoryMutation = useCreateContactMemory();
  const deleteMemoryMutation = useDeleteContactMemory();
  const linkIdentityMutation = useLinkIdentity();
  const batchLinkMutation = useBatchLinkIdentities();
  const unlinkIdentityMutation = useUnlinkIdentity();
  const skipIdentityMutation = useSkipIdentity();
  const unskipIdentityMutation = useUnskipIdentity();
  const refreshCacheMutation = useRefreshCache();

  // Derived data from queries
  const allContacts = () =>
    contactsQuery.isPending || contactsQuery.isLoadingError
      ? []
      : contactsQuery.data ?? [];
  const filteredContacts = createMemo(() => {
    const search = searchQuery().toLowerCase();
    const list = allContacts();
    if (!search) return list;
    return list.filter((c) => c.display_name.toLowerCase().includes(search));
  });
  const unlinkedIdentities = () =>
    unlinkedQuery.isPending || unlinkedQuery.isLoadingError
      ? []
      : unlinkedQuery.data ?? [];
  const skippedIdentitiesList = () =>
    skippedQuery.isPending || skippedQuery.isLoadingError
      ? []
      : skippedQuery.data ?? [];
  const selectedContact = () =>
    selectedContactQuery.isPending || selectedContactQuery.isLoadingError
      ? null
      : selectedContactQuery.data ?? null;
  const recentEvents = () =>
    contactEventsQuery.isPending || contactEventsQuery.isLoadingError
      ? []
      : contactEventsQuery.data?.events ?? [];
  const contactSuggestions = () =>
    contactSuggestionsQuery.isPending || contactSuggestionsQuery.isLoadingError
      ? []
      : contactSuggestionsQuery.data?.suggestions ?? [];
  const identityEvents = () =>
    identityEventsQuery.isPending || identityEventsQuery.isLoadingError
      ? []
      : identityEventsQuery.data?.events ?? [];
  const identityEventCount = () =>
    identityEventsQuery.isPending || identityEventsQuery.isLoadingError
      ? 0
      : identityEventsQuery.data?.count ?? 0;
  const linkSuggestions = () =>
    linkSuggestionsQuery.isPending || linkSuggestionsQuery.isLoadingError
      ? []
      : linkSuggestionsQuery.data?.suggestions ?? [];
  const selectedContactIsStale = () => selectedContactQuery.isPlaceholderData;
  const contactEventsAreStale = () => contactEventsQuery.isPlaceholderData;
  const contactSuggestionsAreStale = () => contactSuggestionsQuery.isPlaceholderData;
  const identityEventsAreStale = () => identityEventsQuery.isPlaceholderData;


  // Group link suggestions by contact for batch operations
  const groupedSuggestions = createMemo(() => {
    const suggestions = linkSuggestions();
    const byContact = new Map<number, {
      contact: typeof suggestions[0]["contact"];
      identities: typeof suggestions;
    }>();

    for (const s of suggestions) {
      let entry = byContact.get(s.contact.id);
      if (!entry) {
        entry = { contact: s.contact, identities: [] };
        byContact.set(s.contact.id, entry);
      }
      entry.identities.push(s);
    }

    return Array.from(byContact.values())
      .sort((a, b) =>
        b.identities.reduce((sum, i) => sum + i.identity.eventCount, 0) -
        a.identities.reduce((sum, i) => sum + i.identity.eventCount, 0)
      );
  });

  const isRefreshing = () => refreshCacheMutation.isPending;

  // Helper to select a contact (writes to URL)
  function selectContact(id: number | null) {
    setContactUpdateError(null);
    setSearchParams({
      id: id ?? undefined,
      unlinked: undefined,
      source: undefined,
    }, { replace: true });
  }

  // Handle keyboard shortcuts for link modal at document level
  createEffect(() => {
    if (!showLinkModal()) return;

    function handleKeyDown(e: KeyboardEvent) {
      const { suggested } = filteredContactsForLink();
      if (suggested.length === 0) return;

      // Enter selects first suggestion (works even when filtering)
      if (e.key === "Enter") {
        e.preventDefault();
        const identity = selectedIdentity();
        if (identity) {
          handleLinkToContact(identity, suggested[0].id);
        }
        return;
      }

      // Number keys only work when not searching (would interfere with typing)
      if (linkSearch()) return;

      // "1", "2", "3", etc. for suggestions
      const num = parseInt(e.key);
      if (num >= 1 && num <= suggested.length) {
        e.preventDefault();
        const identity = selectedIdentity();
        if (identity) {
          handleLinkToContact(identity, suggested[num - 1].id);
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  // Helper to change view mode (syncs to URL via setViewMode)
  function changeViewMode(mode: "contacts" | "unlinked" | "skipped") {
    setViewMode(mode);
    setSuggestionsScrollTop(0); // Reset scroll when view changes
  }

  // Helper to change search query (debounced sync to URL)
  function changeSearchQuery(query: string) {
    setSearchQuery(query);
    setSuggestionsScrollTop(0); // Reset scroll when search changes
  }

  async function handleRefresh() {
    await refreshCacheMutation.mutateAsync();
  }

  async function handleCreateContact() {
    if (!newContactName().trim()) return;
    const contact = await createContactMutation.mutateAsync({
      displayName: newContactName().trim(),
      notes: newContactNotes().trim() || undefined,
    });
    setNewContactName("");
    setNewContactNotes("");
    setShowCreateForm(false);
    selectContact(contact.id);
  }

  async function handleUpdateContact(id: number, updates: {
    displayName?: string; notes?: string; hidden?: boolean; dateOfBirth?: string | null; isSelf?: boolean;
  }): Promise<boolean> {
    setContactUpdateError(null);
    try {
      await updateContactMutation.mutateAsync({ id, updates });
      return true;
    } catch (error) {
      setContactUpdateError(error instanceof Error ? error.message : "Failed to update contact");
      return false;
    }
  }

  async function handleSaveEdit() {
    const editing = editingContact();
    if (editing) {
      const updated = await handleUpdateContact(editing.id, { displayName: editing.display_name });
      if (updated) setEditingContact(null);
    }
  }

  async function handleDeleteContact(id: number) {
    if (!confirm("Delete this contact and all identities?")) return;
    await deleteContactMutation.mutateAsync(id);
    selectContact(null);
  }

  function invalidateIdentityCacheForIdentifier(identifier: string) {
    if (isQualifiedIdentifier(identifier)) {
      invalidateCache([identifier]);
      return;
    }
    clearCache();
  }

  function assertQualifiedIdentity(identifier: string): boolean {
    if (isQualifiedIdentifier(identifier)) return true;
    alert(QUALIFIED_IDENTITY_MESSAGE);
    return false;
  }

  async function handleRemoveIdentity(identity: ContactIdentity) {
    const selected = selectedContact();
    if (selected) {
      const identifier = formatIdentifier(identity.platform, identity.platform_id);
      await unlinkIdentityMutation.mutateAsync({ identifier, contactId: selected.contact.id });
      invalidateIdentityCacheForIdentifier(identifier);
    }
  }

  async function handleSkipIdentity(identity: UnlinkedIdentity) {
    await skipIdentityMutation.mutateAsync({ identifier: identity.identifier, platform: identity.platform });
    invalidateIdentityCacheForIdentifier(identity.identifier);
  }

  async function handleUnskipIdentity(identity: { identifier: string; platform: string }) {
    await unskipIdentityMutation.mutateAsync({ identifier: identity.identifier, platform: identity.platform });
    invalidateIdentityCacheForIdentifier(identity.identifier);
  }

  // Filtered identities computed
  const filteredIdentities = createMemo(() => {
    const search = searchQuery().toLowerCase();
    const sort = suggestionsSort();
    const platform = suggestionsSource();

    let result = unlinkedIdentities();

    // Apply platform filter
    if (platform) {
      result = result.filter((i) => i.platform === platform);
    }

    // Apply search filter
    if (search) {
      result = result.filter(
        (i) =>
          i.identifier.toLowerCase().includes(search) ||
          i.displayName?.toLowerCase().includes(search) ||
          i.username?.toLowerCase().includes(search),
      );
    }

    // Apply sort
    if (sort === "asc") {
      result = [...result].sort((a, b) => a.eventCount - b.eventCount);
    }
    // Default is desc (already sorted by eventCount desc from API)

    return result;
  });

  // Virtual scrolling state for suggestions
  const suggestionsVirtualState = createMemo(() => {
    const items = filteredIdentities();
    const height = suggestionsContainerHeight();
    const scroll = suggestionsScrollTop();

    const totalHeight = items.length * SUGGESTION_ROW_HEIGHT;
    const firstVisible = Math.max(0, Math.floor(scroll / SUGGESTION_ROW_HEIGHT) - SUGGESTION_OVERSCAN);
    const visibleCount = Math.ceil(height / SUGGESTION_ROW_HEIGHT) + SUGGESTION_OVERSCAN * 2;
    const lastVisible = Math.min(items.length, firstVisible + visibleCount);

    return {
      totalHeight,
      firstVisible,
      lastVisible,
      visibleItems: items.slice(firstVisible, lastVisible),
      offsetTop: firstVisible * SUGGESTION_ROW_HEIGHT,
    };
  });

  // Ref callback to set up resize observer when container is created
  function setSuggestionsContainerRef(el: HTMLDivElement) {
    // Use requestAnimationFrame to ensure element is laid out before reading height
    requestAnimationFrame(() => {
      setSuggestionsContainerHeight(el.clientHeight || 400);
      // Restore scroll position when container is recreated
      const savedScroll = suggestionsScrollTop();
      if (savedScroll > 0) {
        el.scrollTop = savedScroll;
      }
    });

    suggestionsResizeObserver?.disconnect();
    suggestionsResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSuggestionsContainerHeight(entry.contentRect.height);
      }
    });
    suggestionsResizeObserver.observe(el);
  }

  // Clean up on unmount
  onCleanup(() => {
    suggestionsResizeObserver?.disconnect();
    clearTimeout(searchDebounceTimer);
  });

  function handleSuggestionsScroll(e: Event) {
    const target = e.currentTarget as HTMLDivElement;
    setSuggestionsScrollTop(target.scrollTop);
  }

  function filteredSkippedIdentities() {
    const search = searchQuery().toLowerCase();
    if (!search) return skippedIdentitiesList();
    return skippedIdentitiesList().filter(
      (i) =>
        i.identifier.toLowerCase().includes(search) ||
        i.displayName?.toLowerCase().includes(search) ||
        i.username?.toLowerCase().includes(search),
    );
  }

  function availablePlatforms() {
    const platforms = new Set<string>();
    for (const identity of unlinkedIdentities()) {
      platforms.add(identity.platform);
    }
    return Array.from(platforms).sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b)));
  }

  const filteredContactsForLink = createMemo(() => {
    const search = linkSearch().toLowerCase();
    const list = allContacts();
    const suggestions = suggestedContactsQuery.data?.suggestions ?? [];
    const suggestedIds = new Set(suggestions.map((s) => s.contactId));

    // Separate suggested and non-suggested contacts
    const suggested = list.filter((c) => suggestedIds.has(c.id));
    const others = list.filter((c) => !suggestedIds.has(c.id));

    // Apply search filter
    const filterFn = (c: ContactWithStats) =>
      !search || c.display_name.toLowerCase().includes(search);

    return {
      suggested: suggested.filter(filterFn),
      others: others.filter(filterFn),
    };
  });

  async function handleCreateAndLink(identity: UnlinkedIdentity) {
    if (!assertQualifiedIdentity(identity.identifier)) return;
    // Create contact and add identity (mutations handle cache invalidation)
    const contact = await createContactMutation.mutateAsync({
      displayName: identity.displayName || getDisplayName(identity.identifier),
    });
    await linkIdentityMutation.mutateAsync({
      contactId: contact.id,
      identifier: identity.identifier,
    });
    invalidateIdentityCacheForIdentifier(identity.identifier);

    // Navigate to the new contact
    setSearchParams({
      id: contact.id,
      view: undefined, // contacts is default
      unlinked: undefined,
      source: undefined,
    }, { replace: true });
  }

  async function handleLinkToContact(identity: UnlinkedIdentity, contactId: number) {
    if (!assertQualifiedIdentity(identity.identifier)) return;
    setShowLinkModal(false);
    setSelectedIdentity(null);

    // Add identity (mutation handles cache invalidation and optimistic update)
    await linkIdentityMutation.mutateAsync({
      contactId,
      identifier: identity.identifier,
    });
    invalidateIdentityCacheForIdentifier(identity.identifier);
  }

  async function handleBatchLinkToContact(contactId: number, identifiers: string[]) {
    setBatchLinkingContact(contactId);
    try {
      const links = identifiers.map((identifier) => ({ identifier, contactId }));
      await batchLinkMutation.mutateAsync(links);
      // Invalidate identity cache for all linked identifiers
      for (const identifier of identifiers) {
        invalidateIdentityCacheForIdentifier(identifier);
      }
    } finally {
      setBatchLinkingContact(null);
    }
  }

  function formatTimestamp(ts: string | Date | null): string {
    if (!ts) return "";
    const date = new Date(ts);
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }



  return (
    <div class="h-full flex relative">
      {/* Contact List Sidebar */}
      <div class="w-80 border-r border-border flex flex-col">
        <div class="p-4 border-b border-border">
          {/* View Mode Tabs */}
          <div class="flex mb-3 border border-border rounded overflow-hidden">
            <button
              class={`flex-1 px-2 py-1.5 text-sm font-medium transition-colors ${
                viewMode() === "contacts"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent"
              }`}
              onClick={() => changeViewMode("contacts")}
            >
              Contacts
            </button>
            <button
              class={`flex-1 px-2 py-1.5 text-sm font-medium transition-colors ${
                viewMode() === "unlinked"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent"
              }`}
              onClick={() => changeViewMode("unlinked")}
            >
              Unlinked
            </button>
            <button
              class={`flex-1 px-2 py-1.5 text-sm font-medium transition-colors ${
                viewMode() === "skipped"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent"
              }`}
              onClick={() => changeViewMode("skipped")}
            >
              Skipped
            </button>
          </div>

          {/* Refresh button */}
          <div class="flex items-center justify-end mb-2">
            <button
              class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              onClick={handleRefresh}
              disabled={isRefreshing()}
            >
              <Show when={isRefreshing()} fallback={
                <IconRefresh class="w-3 h-3" />
              }>
                <IconProgress class="w-3 h-3 animate-spin" />
              </Show>
              {isRefreshing() ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {/* Search input - visible on all tabs */}
          <input
            type="text"
            placeholder={viewMode() === "contacts" ? "Search contacts..." : "Search by name..."}
            class="w-full px-3 py-2 rounded border border-border bg-background text-sm"
            value={searchQuery()}
            onInput={(e) => changeSearchQuery(e.currentTarget.value)}
          />

          {/* Contacts tab extras */}
          <Show when={viewMode() === "contacts"}>
            <div class="flex items-center justify-between mt-2">
              <label class="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showHidden()}
                  onChange={(e) => setShowHidden(e.currentTarget.checked)}
                />
                Show hidden
              </label>
              <button
                class="px-2 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
                onClick={() => setShowCreateForm(true)}
              >
                + New
              </button>
            </div>
          </Show>

          {/* Suggestions tab extras */}
          <Show when={viewMode() === "unlinked"}>
            <div class="flex items-center gap-2 mt-2">
              <select
                class="px-2 py-1 text-sm rounded border border-border bg-background flex-1"
                value={suggestionsSource()}
                onChange={(e) => { setSuggestionsSource(e.currentTarget.value); setSuggestionsScrollTop(0); }}
              >
                <option value="">All platforms</option>
                <For each={availablePlatforms()}>
                  {(platform) => <option value={platform}>{sourceLabel(platform)}</option>}
                </For>
              </select>
            </div>
            <div class="flex items-center gap-2 mt-2">
              <span class="text-sm text-muted-foreground">Sort:</span>
              <button
                class={`px-2 py-1 text-xs rounded border ${
                  suggestionsSort() === "desc"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-accent"
                }`}
                onClick={() => { setSuggestionsSort("desc"); setSuggestionsScrollTop(0); }}
              >
                Most events
              </button>
              <button
                class={`px-2 py-1 text-xs rounded border ${
                  suggestionsSort() === "asc"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-accent"
                }`}
                onClick={() => { setSuggestionsSort("asc"); setSuggestionsScrollTop(0); }}
              >
                Fewest events
              </button>
            </div>
          </Show>
        </div>

        <div class="flex-1 overflow-auto relative">
            {/* Contacts List */}
            <Show when={viewMode() === "contacts"}>
              <Show
                when={!contactsQuery.isPending}
                fallback={<div class="p-4 text-muted-foreground">Loading contacts...</div>}
              >
                <Show
                  when={!contactsQuery.isLoadingError}
                  fallback={<div class="p-4 text-destructive">Failed to load contacts.</div>}
                >
                  <For each={filteredContacts()} fallback={<div class="p-4 text-muted-foreground">No contacts found</div>}>
                    {(contact) => (
                      <button
                        class={`w-full px-4 py-3 text-left border-b border-border hover:bg-accent transition-colors ${
                          selectedContactId() === contact.id ? "bg-accent" : ""
                        } ${contact.hidden ? "opacity-50" : ""}`}
                        onClick={() => selectContact(contact.id)}
                      >
                        <div class="flex items-center gap-3">
                          <Avatar url={contact.avatarUrl} name={contact.display_name} size="md" />
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center justify-between gap-2">
                              <span class="font-medium truncate">{contact.display_name}</span>
                              <Show when={contact.is_self || contact.hidden}>
                                <span class="flex items-center gap-2 shrink-0">
                                  <Show when={contact.is_self}>
                                    <YouBadge />
                                  </Show>
                                  <Show when={contact.hidden}>
                                    <span class="text-xs text-muted-foreground">(hidden)</span>
                                  </Show>
                                </span>
                              </Show>
                            </div>
                            <div class="text-sm text-muted-foreground">
                              {contact.identityCount} identities, {contact.eventCount} events
                            </div>
                          </div>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>

            {/* Unlinked Identities List - Virtual Scrolling */}
            <Show when={viewMode() === "unlinked"}>
              <div class="absolute inset-0 flex flex-col">
                {/* Link Suggestions Summary Card */}
                <Show when={linkSuggestions().length > 0}>
                  <button
                    class={`border-b border-border p-3 flex-shrink-0 text-left hover:bg-accent/50 transition-colors ${
                      !selectedUnlinked() && !selectedContactId() ? "bg-accent" : ""
                    }`}
                    onClick={() => setSearchParams({ id: undefined, unlinked: undefined, source: undefined }, { replace: true })}
                  >
                    <div class="flex items-center gap-2">
                      <IconBolt class="w-4 h-4 text-primary flex-shrink-0" />
                      <span class="text-sm font-medium">
                        {linkSuggestions().length} Quick Link Suggestion{linkSuggestions().length !== 1 && "s"}
                      </span>
                      <IconChevronRight class="w-4 h-4 text-muted-foreground ml-auto" />
                    </div>
                  </button>
                </Show>

                {/* Empty state */}
                <Show when={filteredIdentities().length === 0 && linkSuggestions().length === 0}>
                  <div class="flex-1 flex items-center justify-center p-4 text-muted-foreground">
                    All people have been linked!
                  </div>
                </Show>

                {/* Virtual scrolling list */}
                <Show when={filteredIdentities().length > 0}>
                  <div class="flex-1 relative">
                    <div
                      ref={setSuggestionsContainerRef}
                      class="absolute inset-0 overflow-auto pb-8"
                      onScroll={handleSuggestionsScroll}
                    >
                      <div
                        style={{
                          height: `${suggestionsVirtualState().totalHeight}px`,
                          position: "relative",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            top: `${suggestionsVirtualState().offsetTop}px`,
                            width: "100%",
                          }}
                        >
                          <For each={suggestionsVirtualState().visibleItems}>
                            {(identity) => {
                              const qualified = isQualifiedIdentifier(identity.identifier);
                              const label = identity.displayName || identity.username || identity.platformId;
                              return (
                                <div
                                  class="px-4 py-3 border-b border-border"
                                  style={{ height: `${SUGGESTION_ROW_HEIGHT}px`, "box-sizing": "border-box" }}
                                >
                                  <div class="flex items-center gap-2 mb-1">
                                    <Avatar url={identity.avatarUrl} name={label} size="sm" />
                                    <button
                                      class="font-medium truncate flex-1 text-left hover:text-primary"
                                      onClick={() => openUnlinkedIdentity(identity.identifier, identity.platform)}
                                      title="View events with this person"
                                    >
                                      {label}
                                    </button>
                                    <span class="text-xs px-2 py-0.5 rounded source-badge" style={getSourceColorStyle(identity.platform)}>
                                      {sourceLabel(identity.platform)}
                                    </span>
                                  </div>
                                  <div class="flex items-center gap-2 mb-2">
                                    <span class="text-xs font-mono text-muted-foreground truncate flex-1">
                                      {identity.identifier}
                                    </span>
                                    <button
                                      class="text-xs text-muted-foreground hover:text-foreground hover:underline whitespace-nowrap"
                                      onClick={() => navigateToSearch(`"${identity.identifier}" source:${identity.platform}`)}
                                    >
                                      {identity.eventCount} events
                                    </button>
                                  </div>
                                  <div class="flex gap-2">
                                    <button
                                      class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded enabled:hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                                      disabled={!qualified}
                                      title={qualified ? undefined : QUALIFIED_IDENTITY_MESSAGE}
                                      onClick={() => handleCreateAndLink(identity)}
                                    >
                                      Create Contact
                                    </button>
                                    <button
                                      class="px-2 py-1 text-xs border border-border rounded enabled:hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                                      disabled={!qualified}
                                      title={qualified ? undefined : QUALIFIED_IDENTITY_MESSAGE}
                                      onClick={() => {
                                        setSelectedIdentity(identity);
                                        setLinkSearch("");
                                        setShowLinkModal(true);
                                      }}
                                    >
                                      Link to...
                                    </button>
                                    <button
                                      class="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                                      onClick={() => handleSkipIdentity(identity)}
                                    >
                                      Skip
                                    </button>
                                  </div>
                                </div>
                              );
                            }}
                          </For>
                        </div>
                      </div>
                    </div>
                    {/* Count indicator fixed at bottom */}
                    <div class="absolute bottom-0 left-0 right-0 p-2 text-center text-xs text-muted-foreground bg-background/80 backdrop-blur-sm border-t border-border">
                      <span class="font-mono">{filteredIdentities().length.toLocaleString()}</span> unlinked {filteredIdentities().length === 1 ? "person" : "people"}
                      <Show when={searchQuery()}>{` matching "${searchQuery()}"`}</Show>
                    </div>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Skipped Identities List */}
            <Show when={viewMode() === "skipped"}>
              <Show when={filteredSkippedIdentities().length === 0}>
                <div class="p-4 text-muted-foreground">No skipped identities</div>
              </Show>
              <Show when={filteredSkippedIdentities().length > 0}>
                <div class="absolute inset-0 overflow-auto pb-10">
                  <For each={filteredSkippedIdentities()}>
                    {(identity) => {
                      const label = identity.displayName || identity.username || identity.platformId;
                      return (
                        <div class="px-4 py-3 border-b border-border">
                          <div class="flex items-center gap-2 mb-1">
                            <Avatar url={identity.avatarUrl} name={label} size="sm" />
                            <button
                              class="font-medium truncate flex-1 text-left hover:text-primary"
                              onClick={() => openUnlinkedIdentity(identity.identifier, identity.platform)}
                              title="View events with this person"
                            >
                              {label}
                            </button>
                            <span class="text-xs px-2 py-0.5 rounded source-badge" style={getSourceColorStyle(identity.platform)}>
                              {sourceLabel(identity.platform)}
                            </span>
                          </div>
                          <div class="flex items-center gap-2 mb-2">
                            <span class="text-xs font-mono text-muted-foreground truncate flex-1">
                              {identity.identifier}
                            </span>
                            <button
                              class="text-xs text-muted-foreground hover:text-foreground hover:underline whitespace-nowrap"
                              onClick={() => navigateToSearch(`"${identity.identifier}" source:${identity.platform}`)}
                            >
                              {identity.eventCount} events
                            </button>
                          </div>
                          <div class="flex gap-2">
                            <button
                              class="px-2 py-1 text-xs border border-border rounded hover:bg-accent"
                              onClick={() => handleUnskipIdentity(identity)}
                            >
                              Restore
                            </button>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
                {/* Count indicator fixed at bottom */}
                <div class="absolute bottom-0 left-0 right-0 p-2 text-center text-xs text-muted-foreground bg-background/80 backdrop-blur-sm border-t border-border">
                  <span class="font-mono">{filteredSkippedIdentities().length.toLocaleString()}</span> skipped {filteredSkippedIdentities().length === 1 ? "person" : "people"}
                  <Show when={searchQuery()}>{` matching "${searchQuery()}"`}</Show>
                </div>
              </Show>
            </Show>
        </div>
      </div>

      {/* Detail Panel */}
      <div class="flex-1 overflow-auto">
        {/* Unlinked Identity Detail */}
        <Show when={selectedUnlinked()}>
          {(unlinked) => {
            // Resolve the identity so display name is available
            createEffect(on(() => unlinked().identifier, (id) => {
              resolveIdentifiers([id]);
            }));
            const displayName = () => getDisplayName(unlinked().identifier);
            const avatarUrl = () => getAvatarUrl(unlinked().identifier);
            return (
              <div class="p-6 max-w-3xl mx-auto">
                {/* Header */}
                <div class="flex items-start justify-between mb-6">
                  <div class="flex items-center gap-3">
                    <Avatar url={avatarUrl()} name={displayName()} size="lg" />
                    <div>
                      <h1 class="font-display text-2xl font-medium">{displayName()}</h1>
                      <div class="flex items-center gap-2 mt-1">
                        <span class="text-xs px-2 py-0.5 rounded source-badge" style={getSourceColorStyle(unlinked().source)}>
                          {sourceLabel(unlinked().source)}
                        </span>
                        <span class="text-sm font-mono text-muted-foreground">{unlinked().identifier}</span>
                      </div>
                    </div>
                  </div>
                  <div class="flex gap-2">
                    <button
                      class="px-3 py-1 text-sm border border-border rounded hover:bg-accent"
                      onClick={() => setSearchParams({ unlinked: undefined, source: undefined }, { replace: true })}
                    >
                      Close
                    </button>
                  </div>
                </div>

                {/* Actions */}
                <div class="flex gap-2 mb-6">
                  <button
                    class="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
                    onClick={() => {
                      const identity: UnlinkedIdentity = {
                        identifier: unlinked().identifier,
                        platform: unlinked().source,
                        platformId: unlinked().identifier.split(":")[1] || "",
                        displayName: null,
                        username: null,
                        eventCount: identityEventCount(),
                        avatarUrl: avatarUrl() ?? null,
                      };
                      handleCreateAndLink(identity);
                    }}
                  >
                    Create Contact
                  </button>
                  <button
                    class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent"
                    onClick={() => {
                      const identity: UnlinkedIdentity = {
                        identifier: unlinked().identifier,
                        platform: unlinked().source,
                        platformId: unlinked().identifier.split(":")[1] || "",
                        displayName: null,
                        username: null,
                        eventCount: identityEventCount(),
                        avatarUrl: avatarUrl() ?? null,
                      };
                      setSelectedIdentity(identity);
                      setLinkSearch("");
                      setShowLinkModal(true);
                    }}
                  >
                    Link to Existing...
                  </button>
                  <button
                    class="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      handleSkipIdentity({
                        identifier: unlinked().identifier,
                        platform: unlinked().source,
                        platformId: unlinked().identifier.split(":")[1] || "",
                        displayName: null,
                        username: null,
                        eventCount: identityEventCount(),
                        avatarUrl: avatarUrl() ?? null,
                      });
                      setSearchParams({ unlinked: undefined, source: undefined }, { replace: true });
                    }}
                  >
                    Skip
                  </button>
                </div>

                {/* Recent Events */}
                <div class={staleContentClass(identityEventsAreStale())} aria-busy={identityEventsAreStale()}>
                  <div class="flex items-center justify-between mb-3">
                    <h2 class="text-lg font-semibold">
                      Recent Events
                      <Show when={identityEventCount() > 0}>
                        <span class="ml-2 text-sm font-normal text-muted-foreground">
                          (<span class="font-mono">{identityEventCount().toLocaleString()}</span> total)
                        </span>
                      </Show>
                    </h2>
                    <button
                      class="text-sm text-primary hover:underline"
                      onClick={() => navigateToSearch(`"${unlinked().identifier}" source:${unlinked().source}`)}
                    >
                      View all
                    </button>
                  </div>
                  <div class="space-y-2">
                    <For each={identityEvents()} fallback={<div class="text-muted-foreground">No events found</div>}>
                      {(event) => (
                        <button
                          class="w-full text-left p-3 rounded bg-card hover:bg-accent transition-colors"
                          onClick={() => {
                            if (event.type?.startsWith("message") && event.conversation_id) {
                              openConversation(event.source, event.conversation_id, event.id);
                            }
                          }}
                        >
                          <div class="flex items-center gap-2 mb-1">
                            <span class="text-xs px-2 py-0.5 rounded source-badge" style={getSourceColorStyle(event.source)}>
                              {sourceLabel(event.source)}
                            </span>
                            <span class="text-xs text-muted-foreground">{event.type}</span>
                            <span class="text-xs text-muted-foreground ml-auto">
                              <span class="font-mono">{formatTimestamp(event.timestamp)}</span>
                            </span>
                          </div>
                          <Show when={event.title}>
                            <div class="font-medium truncate">{event.title}</div>
                          </Show>
                          <Show when={event.content && event.content !== event.title}>
                            <div class="text-sm text-muted-foreground truncate">{event.content}</div>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            );
          }}
        </Show>

        {/* Contact Detail */}
        <Show when={!selectedUnlinked() && selectedContactId() !== undefined && selectedContact()}>
          {(selected) => (
            <div class={`p-6 max-w-3xl mx-auto ${staleContentClass(selectedContactIsStale())}`} aria-busy={selectedContactIsStale()}>
              {/* Header */}
              <div class="flex items-start justify-between mb-6">
                <div class="flex items-center gap-4">
                  <Avatar url={selected().avatarUrl} name={selected().contact.display_name} size="lg" />
                  <div>
                    <Show
                      when={editingContact()?.id === selected().contact.id}
                      fallback={
                        <h1 class="font-display text-2xl font-medium flex items-center gap-2">
                          {selected().contact.display_name}
                          <Show when={selected().contact.is_self}>
                            <YouBadge ariaHidden />
                          </Show>
                        </h1>
                      }
                    >
                    <input
                      type="text"
                      class="font-display text-2xl font-medium bg-background border border-border rounded px-2 py-1"
                      value={editingContact()?.display_name || ""}
                      onInput={(e) =>
                        setEditingContact((prev) =>
                          prev ? { ...prev, display_name: e.currentTarget.value } : null
                        )
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleSaveEdit();
                        } else if (e.key === "Escape") {
                          setEditingContact(null);
                        }
                      }}
                    />
                  </Show>
                  </div>
                </div>
                <div class="flex gap-2">
                  <Show
                    when={editingContact()?.id === selected().contact.id}
                    fallback={
                      <button
                        class="px-3 py-1 text-sm border border-border rounded hover:bg-accent"
                        onClick={() => setEditingContact(selected().contact)}
                      >
                        Edit
                      </button>
                    }
                  >
                    <button
                      class="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
                      onClick={handleSaveEdit}
                    >
                      Save
                    </button>
                    <button
                      class="px-3 py-1 text-sm border border-border rounded hover:bg-accent"
                      onClick={() => setEditingContact(null)}
                    >
                      Cancel
                    </button>
                  </Show>
                  <button
                    class="px-3 py-1 text-sm border border-border rounded enabled:hover:bg-accent disabled:opacity-50"
                    disabled={updateContactMutation.isPending}
                    aria-busy={updateContactMutation.isPending}
                    onClick={() => {
                      void handleUpdateContact(selected().contact.id, { isSelf: !selected().contact.is_self });
                    }}
                  >
                    {selected().contact.is_self ? "Not me" : "This is me"}
                  </button>
                  <button
                    class={`px-3 py-1 text-sm border rounded ${
                      selected().contact.hidden
                        ? "border-green-500 text-green-500 hover:bg-green-500/10"
                        : "border-yellow-500 text-yellow-500 hover:bg-yellow-500/10"
                    }`}
                    disabled={updateContactMutation.isPending}
                    onClick={() => {
                      void handleUpdateContact(selected().contact.id, { hidden: !selected().contact.hidden });
                    }}
                  >
                    {selected().contact.hidden ? "Unhide" : "Hide"}
                  </button>
                  <button
                    class="px-3 py-1 text-sm border border-red-500 text-red-500 rounded hover:bg-red-500/10"
                    onClick={() => handleDeleteContact(selected().contact.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              <Show when={contactUpdateError()}>
                {(error) => <p role="alert" class="-mt-4 mb-4 text-sm text-red-400">{error()}</p>}
              </Show>

              {/* Profile Fields */}
              <ContactProfileFields
                contact={selected().contact}
                identities={selected().identities}
                onUpdate={(updates) => { void handleUpdateContact(selected().contact.id, updates); }}
              />

              {/* Notes */}
              <ContactNotes
                contact={selected().contact}
                onUpdate={(notes) => { void handleUpdateContact(selected().contact.id, { notes }); }}
              />

              {/* AI Memories */}
              <ContactMemories
                memories={selected().memories ?? []}
                contactId={selected().contact.id}
                onAdd={(content) => createMemoryMutation.mutateAsync({ contactId: selected().contact.id, content })}
                onDelete={(memoryId) => deleteMemoryMutation.mutateAsync({ contactId: selected().contact.id, memoryId })}
              />

              {/* Identities */}
              <div class="mb-6">
                <div class="flex items-center gap-2 mb-3">
                  <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Identities</h2>
                  <span class="h-px flex-1 bg-border" />
                </div>
                <div class="max-h-96 overflow-y-auto space-y-2 pr-1">
                  <For each={selected().identities} fallback={<div class="text-muted-foreground">No identities yet</div>}>
                    {(identity) => {
                      const identifier = formatIdentifier(identity.platform, identity.platform_id);
                      const label = identity.display_name || identity.username || getDisplayName(identifier);
                      return (
                        <div class="flex items-center gap-2 p-2 rounded bg-card">
                          <Avatar url={identity.avatar_url} name={label} size="sm" />
                          <div class="min-w-0 flex-1">
                            <div class="font-medium truncate">{label}</div>
                            <div class="text-xs font-mono text-muted-foreground truncate">{identifier}</div>
                          </div>
                          <span class="text-xs px-2 py-0.5 rounded source-badge" style={getSourceColorStyle(identity.platform)}>
                            {sourceLabel(identity.platform)}
                          </span>
                          <button
                            class="ml-auto text-sm text-muted-foreground hover:text-red-500"
                            onClick={() => handleRemoveIdentity(identity)}
                          >
                            Remove
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>

                <p class="mt-3 text-sm text-muted-foreground">
                  Link identities from the Suggestions tab.
                </p>
              </div>

              {/* Suggested Identities */}
              <Show when={contactSuggestions().length > 0}>
                <div class={`mb-6 ${staleContentClass(contactSuggestionsAreStale())}`} aria-busy={contactSuggestionsAreStale()}>
                  <h2 class="text-lg font-semibold mb-3">
                    Suggested Identities
                    <span class="ml-2 text-sm font-normal text-muted-foreground">
                      (<span class="font-mono">{contactSuggestions().length}</span>)
                    </span>
                  </h2>
                  <p class="text-sm text-muted-foreground mb-3">
                    These identities have similar names to existing linked identities.
                  </p>
                  <div class="max-h-96 overflow-y-auto space-y-2 pr-1">
                    <For each={contactSuggestions()}>
                      {(suggestion) => (
                        <div class="flex items-center gap-2 p-2 rounded bg-card border border-dashed border-border">
                          <div class="min-w-0 flex-1">
                            <div class="font-medium truncate">{getDisplayName(suggestion.alias)}</div>
                            <div class="text-xs text-muted-foreground truncate">
                              Matches "{getDisplayName(suggestion.matched_alias)}"
                            </div>
                          </div>
                          <span
                            class="text-xs px-2 py-0.5 rounded source-badge"
                            style={getSourceColorStyle(suggestion.source)}
                          >
                            {sourceLabel(suggestion.source)}
                          </span>
                          <button
                            class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
                            onClick={async () => {
                              await linkIdentityMutation.mutateAsync({
                                contactId: selected().contact.id,
                                identifier: suggestion.alias,
                              });
                              invalidateIdentityCacheForIdentifier(suggestion.alias);
                            }}
                          >
                            Link
                          </button>
                          <button
                            class="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                            onClick={async () => {
                              const parts = suggestion.alias.split(":");
                              await skipIdentityMutation.mutateAsync({
                                identifier: suggestion.alias,
                                platform: parts[0],
                              });
                              invalidateIdentityCacheForIdentifier(suggestion.alias);
                            }}
                          >
                            Skip
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              {/* Spotify Activity */}
              <div class="mb-6">
                <ContactSpotifySummary contactId={selected().contact.id} />
              </div>

              {/* Conversations */}
              <div class="mb-6">
                <ContactConversations contactId={selected().contact.id} />
              </div>

              {/* Recent Events */}
              <div class={staleContentClass(contactEventsAreStale())} aria-busy={contactEventsAreStale()}>
                <div class="flex items-center gap-2 mb-3">
                  <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Recent Events</h2>
                  <span class="h-px flex-1 bg-border" />
                  <button
                    class="text-sm text-primary hover:underline"
                    onClick={() => navigateToSearch(`contact:${selected().contact.id}`)}
                  >
                    View all
                  </button>
                </div>
                <div class="space-y-2">
                  <For each={recentEvents()} fallback={<div class="text-muted-foreground">No events found</div>}>
                    {(event) => (
                      <button
                        class="w-full text-left p-3 rounded bg-card hover:bg-accent transition-colors"
                        onClick={() => {
                          if (event.type?.startsWith("message") && event.conversation_id) {
                            openConversation(event.source, event.conversation_id, event.id);
                          }
                        }}
                      >
                        <div class="flex items-center gap-2 mb-1">
                          <span class="text-xs px-2 py-0.5 rounded source-badge" style={getSourceColorStyle(event.source)}>
                            {sourceLabel(event.source)}
                          </span>
                          <span class="text-xs text-muted-foreground">{event.type}</span>
                          <span class="text-xs text-muted-foreground ml-auto">
                            <span class="font-mono">{formatTimestamp(event.timestamp)}</span>
                          </span>
                        </div>
                        <Show when={event.title}>
                          <div class="font-medium truncate">{event.title}</div>
                        </Show>
                        <Show when={event.content && event.content !== event.title}>
                          <div class="text-sm text-muted-foreground truncate">{event.content}</div>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          )}
        </Show>

        {/* Link Suggestions Panel (grouped by contact, shown when no identity selected in unlinked view) */}
        <Show when={!selectedUnlinked() && !selectedContactId() && viewMode() === "unlinked" && groupedSuggestions().length > 0}>
          <div class="p-6 max-w-3xl mx-auto">
            <div class="flex items-center gap-3 mb-6">
              <IconBolt class="w-6 h-6 text-primary" />
              <div>
                <h1 class="font-display text-2xl font-medium">Quick Link Suggestions</h1>
                <p class="text-sm text-muted-foreground">
                  <span class="font-mono">{linkSuggestions().length}</span> {linkSuggestions().length === 1 ? "identity" : "identities"} for <span class="font-mono">{groupedSuggestions().length}</span> {groupedSuggestions().length === 1 ? "contact" : "contacts"}
                </p>
              </div>
            </div>

            <div class="space-y-4">
              <For each={groupedSuggestions()}>
                {(group) => {
                  const isLinking = () => batchLinkingContact() === group.contact.id;

                  return (
                    <div class="rounded-lg bg-card overflow-hidden">
                      {/* Contact header with Accept All button */}
                      <div class="p-4 bg-muted/30 border-b border-border flex items-center justify-between">
                        <div>
                          <div class="font-medium">{group.contact.displayName}</div>
                          <div class="text-sm text-muted-foreground">
                            <span class="font-mono">{group.contact.identityCount}</span> existing {group.contact.identityCount === 1 ? "identity" : "identities"}, <span class="font-mono">{group.contact.eventCount.toLocaleString()}</span> events
                          </div>
                        </div>

                        <Show when={group.identities.length > 1}>
                          <button
                            class="px-3 py-1.5 rounded-sm bg-primary text-primary-foreground text-sm font-medium enabled:hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
                            disabled={isLinking()}
                            onClick={() => handleBatchLinkToContact(
                              group.contact.id,
                              group.identities.map((i) => i.identity.identifier)
                            )}
                          >
                            <Show when={isLinking()} fallback={
                              <>
                                <IconCheck class="w-4 h-4" />
                                Accept All ({group.identities.length})
                              </>
                            }>
                              <IconProgress class="w-4 h-4 animate-spin" />
                              Linking...
                            </Show>
                          </button>
                        </Show>
                      </div>

                      {/* Individual identities */}
                      <div class="divide-y divide-border">
                        <For each={group.identities}>
                          {(suggestion) => {
                            const identityLabel = suggestion.identity.displayName || suggestion.identity.username || suggestion.identity.platformId;
                            return (
                              <div class="p-3 flex items-center gap-3">
                                <Avatar url={suggestion.identity.avatarUrl} name={identityLabel} size="sm" />
                                <div class="flex-1 min-w-0">
                                  <div class="flex items-center gap-2">
                                    <span class="font-medium text-sm">{identityLabel}</span>
                                    <span class="text-xs px-2 py-0.5 rounded-sm source-badge" style={getSourceColorStyle(suggestion.identity.platform)}>
                                      {sourceLabel(suggestion.identity.platform)}
                                    </span>
                                  </div>
                                  <div class="text-xs text-muted-foreground">
                                    <span class="font-mono">{suggestion.identity.eventCount.toLocaleString()}</span> event{suggestion.identity.eventCount !== 1 && "s"}
                                  </div>
                                </div>

                                {/* Individual action buttons */}
                                <div class="flex items-center gap-1 flex-shrink-0">
                                  {/* Accept single */}
                                  <button
                                    class="p-1.5 rounded-sm hover:bg-accent text-green-600 dark:text-green-500"
                                    title="Link this identity"
                                    disabled={isLinking()}
                                    onClick={() => {
                                      const identity: UnlinkedIdentity = {
                                        identifier: suggestion.identity.identifier,
                                        platform: suggestion.identity.platform,
                                        platformId: suggestion.identity.platformId,
                                        displayName: suggestion.identity.displayName,
                                        username: suggestion.identity.username,
                                        eventCount: suggestion.identity.eventCount,
                                        avatarUrl: suggestion.identity.avatarUrl,
                                      };
                                      handleLinkToContact(identity, group.contact.id);
                                    }}
                                  >
                                    <IconCheck class="w-4 h-4" />
                                  </button>
                                  {/* Link to different contact */}
                                  <button
                                    class="p-1.5 rounded-sm hover:bg-accent text-muted-foreground hover:text-foreground"
                                    title="Link to a different contact"
                                    disabled={isLinking()}
                                    onClick={() => {
                                      const identity: UnlinkedIdentity = {
                                        identifier: suggestion.identity.identifier,
                                        platform: suggestion.identity.platform,
                                        platformId: suggestion.identity.platformId,
                                        displayName: suggestion.identity.displayName,
                                        username: suggestion.identity.username,
                                        eventCount: suggestion.identity.eventCount,
                                        avatarUrl: suggestion.identity.avatarUrl,
                                      };
                                      setSelectedIdentity(identity);
                                      setLinkSearch("");
                                      setShowLinkModal(true);
                                    }}
                                  >
                                    <IconEdit class="w-4 h-4" />
                                  </button>
                                  {/* Skip */}
                                  <button
                                    class="p-1.5 rounded-sm hover:bg-accent text-muted-foreground hover:text-red-600 dark:hover:text-red-500"
                                    title="Skip this suggestion"
                                    disabled={isLinking()}
                                    onClick={() => {
                                      handleSkipIdentity({
                                        identifier: suggestion.identity.identifier,
                                        platform: suggestion.identity.platform,
                                        platformId: suggestion.identity.platformId,
                                        displayName: suggestion.identity.displayName,
                                        username: suggestion.identity.username,
                                        eventCount: suggestion.identity.eventCount,
                                        avatarUrl: suggestion.identity.avatarUrl,
                                      });
                                    }}
                                  >
                                    <IconClose class="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            );
                          }}
                        </For>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* Empty State */}
        <Show when={!selectedUnlinked() && !selectedContactId() && !(viewMode() === "unlinked" && linkSuggestions().length > 0)}>
          <div class="h-full flex items-center justify-center text-muted-foreground">
            <Show when={viewMode() === "contacts"}>
              <span>Select a contact to view details</span>
            </Show>
            <Show when={viewMode() === "unlinked"}>
              <div class="text-center max-w-md px-4">
                <p class="text-lg mb-2">Link people to contacts</p>
                <p class="text-sm">
                  Use "Create Contact" to create a new contact from an unlinked person,
                  or "Link to..." to link their identity to an existing contact.
                </p>
              </div>
            </Show>
            <Show when={viewMode() === "skipped"}>
              <div class="text-center max-w-md px-4">
                <p class="text-lg mb-2">Skipped identities</p>
                <p class="text-sm">
                  These people have been skipped and won't appear in suggestions.
                  Click "Restore" to add them back to suggestions.
                </p>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      {/* Create Contact Modal */}
      <Show when={showCreateForm()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div class="bg-background rounded-lg border border-border p-6 w-96">
            <h2 class="text-lg font-semibold mb-4">Create Contact</h2>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium mb-1">Display Name</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 rounded border border-border bg-background"
                  value={newContactName()}
                  onInput={(e) => setNewContactName(e.currentTarget.value)}
                  onKeyUp={(e) => e.key === "Enter" && handleCreateContact()}
                />
              </div>
              <div>
                <label class="block text-sm font-medium mb-1">Notes (optional)</label>
                <input
                  type="text"
                  class="w-full px-3 py-2 rounded border border-border bg-background"
                  value={newContactNotes()}
                  onInput={(e) => setNewContactNotes(e.currentTarget.value)}
                />
              </div>
              <div class="flex justify-end gap-2">
                <button
                  class="px-4 py-2 text-sm border border-border rounded hover:bg-accent"
                  onClick={() => setShowCreateForm(false)}
                >
                  Cancel
                </button>
                <button
                  class="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
                  onClick={handleCreateContact}
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Link to Contact Modal */}
      <Show when={showLinkModal() && selectedIdentity()}>
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div class="bg-background rounded-lg border border-border p-6 w-96 max-h-[80vh] flex flex-col">
            <h2 class="text-lg font-semibold mb-2">Link to Contact</h2>
            {(() => {
              const identity = selectedIdentity();
              if (!identity) return null;
              const label = identity.displayName || identity.username || getDisplayName(identity.identifier);
              const hasName = label !== identity.platformId;
              return (
                <div class="mb-3 flex items-center gap-2">
                  <Avatar url={identity.avatarUrl} name={label} size="sm" />
                  <div class="min-w-0 flex-1">
                    <div class="font-medium truncate">{label}</div>
                    <Show when={hasName}>
                      <div class="text-xs text-muted-foreground font-mono truncate">{identity.platformId}</div>
                    </Show>
                  </div>
                  <span class="text-xs px-2 py-0.5 rounded source-badge shrink-0" style={getSourceColorStyle(identity.platform)}>
                    {sourceLabel(identity.platform)}
                  </span>
                </div>
              );
            })()}
            <input
              type="text"
              placeholder="Search contacts..."
              class="w-full px-3 py-2 rounded border border-border bg-background mb-3"
              value={linkSearch()}
              onInput={(e) => setLinkSearch(e.currentTarget.value)}
              autofocus
            />
            <div class="flex-1 overflow-auto space-y-1 mb-4 max-h-64">
              {/* Suggested section */}
              <Show when={filteredContactsForLink().suggested.length > 0}>
                <div class="text-xs text-muted-foreground px-3 py-1 font-medium flex justify-between">
                  <span>Suggested</span>
                  <span class="opacity-60">
                    Press Enter{!linkSearch() && filteredContactsForLink().suggested.length > 1 ? ` or 1-${filteredContactsForLink().suggested.length}` : ""}
                  </span>
                </div>
                <For each={filteredContactsForLink().suggested}>
                  {(contact, index) => (
                    <button
                      class="w-full text-left px-3 py-2 rounded hover:bg-accent bg-primary/5 border border-primary/20"
                      onClick={() => { const sel = selectedIdentity(); if (sel) handleLinkToContact(sel, contact.id); }}
                    >
                      <div class="flex items-center gap-2">
                        <span class="text-xs text-muted-foreground font-mono w-4">{index() + 1}</span>
                        <div class="flex-1 min-w-0">
                          <div class="font-medium truncate">{contact.display_name}</div>
                          <div class="text-sm text-muted-foreground">
                            {contact.identityCount} identities, {contact.eventCount} events
                          </div>
                        </div>
                      </div>
                    </button>
                  )}
                </For>
              </Show>

              {/* All contacts section */}
              <Show when={filteredContactsForLink().others.length > 0}>
                <Show when={filteredContactsForLink().suggested.length > 0}>
                  <div class="text-xs text-muted-foreground px-3 py-1 font-medium mt-2">
                    All Contacts
                  </div>
                </Show>
                <For each={filteredContactsForLink().others}>
                  {(contact) => (
                    <button
                      class="w-full text-left px-3 py-2 rounded hover:bg-accent"
                      onClick={() => { const sel = selectedIdentity(); if (sel) handleLinkToContact(sel, contact.id); }}
                    >
                      <div class="font-medium truncate">{contact.display_name}</div>
                      <div class="text-sm text-muted-foreground">
                        {contact.identityCount} identities, {contact.eventCount} events
                      </div>
                    </button>
                  )}
                </For>
              </Show>

              <Show when={filteredContactsForLink().suggested.length === 0 && filteredContactsForLink().others.length === 0}>
                <div class="text-muted-foreground p-2">No contacts found</div>
              </Show>
            </div>
            <div class="flex justify-end gap-2">
              <button
                class="px-4 py-2 text-sm border border-border rounded hover:bg-accent"
                onClick={() => {
                  setShowLinkModal(false);
                  setSelectedIdentity(null);
                  setLinkSearch("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

// --- Helper components for contact detail ---

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseBirthday(value: string): { year: number | null; month: number; day: number } {
  if (value.startsWith("--")) {
    const month = parseInt(value.slice(2, 4), 10);
    const day = parseInt(value.slice(5, 7), 10);
    return { year: null, month, day };
  }
  const [y, m, d] = value.split("-").map(Number);
  return { year: y, month: m, day: d };
}

function formatBirthday(value: string): string {
  const { year, month, day } = parseBirthday(value);
  const monthName = MONTH_NAMES[month - 1];
  return year != null ? `${day} ${monthName} ${year}` : `${day} ${monthName}`;
}

function BirthdayField(props: {
  value: string | null;
  onSave: (value: string | null) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [dayDraft, setDayDraft] = createSignal("");
  const [monthDraft, setMonthDraft] = createSignal("");
  const [yearDraft, setYearDraft] = createSignal("");
  let cancelled = false;

  const startEditing = () => {
    cancelled = false;
    if (props.value) {
      const parsed = parseBirthday(props.value);
      setDayDraft(String(parsed.day));
      setMonthDraft(String(parsed.month));
      setYearDraft(parsed.year != null ? String(parsed.year) : "");
    } else {
      setDayDraft("");
      setMonthDraft("");
      setYearDraft("");
    }
    setEditing(true);
  };

  const save = () => {
    if (cancelled) return;
    const day = dayDraft().trim();
    const month = monthDraft().trim();
    const year = yearDraft().trim();
    // Both empty = clear birthday; one filled + one empty = incomplete, cancel
    if (!day && !month) {
      if (props.value !== null) props.onSave(null);
    } else if (!day || !month) {
      // Incomplete — don't save
    } else {
      const m = month.padStart(2, "0");
      const d = day.padStart(2, "0");
      const val = year ? `${year.padStart(4, "0")}-${m}-${d}` : `--${m}-${d}`;
      if (val !== props.value) props.onSave(val);
    }
    setEditing(false);
  };

  const cancel = () => { cancelled = true; setEditing(false); };

  const handleFocusOut = (e: FocusEvent) => {
    const container = e.currentTarget as HTMLElement;
    const next = e.relatedTarget as HTMLElement | null;
    if (!next || !container.contains(next)) save();
  };

  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") cancel(); };

  const inputClass = "text-sm bg-background border border-border rounded px-1.5 py-0.5";

  return (
    <div class="flex items-center gap-2 py-1.5">
      <span class="text-sm text-muted-foreground w-20 shrink-0">Birthday</span>
      <Show
        when={editing()}
        fallback={
          <button
            class="text-sm text-left truncate hover:bg-accent px-1.5 py-0.5 rounded -ml-1.5 min-w-0 flex-1"
            onClick={startEditing}
          >
            {props.value
              ? formatBirthday(props.value)
              : <span class="text-muted-foreground">Add birthday...</span>}
          </button>
        }
      >
        <div class="flex items-end gap-1.5 flex-1 min-w-0" onFocusOut={handleFocusOut}>
          <label class="flex flex-col gap-0.5">
            <span class="text-xs text-muted-foreground">Day</span>
            <input
              type="number" min="1" max="31" placeholder="DD"
              class={`${inputClass} w-14`}
              ref={(el) => queueMicrotask(() => el.focus())}
              value={dayDraft()}
              onInput={(e) => setDayDraft(e.currentTarget.value)}
              onKeyDown={onKey}
            />
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-xs text-muted-foreground">Month</span>
            <select class={inputClass} value={monthDraft()} onChange={(e) => setMonthDraft(e.currentTarget.value)} onKeyDown={onKey}>
              <option value="" />
              <For each={MONTH_NAMES}>
                {(name, i) => <option value={i() + 1}>{name}</option>}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-0.5">
            <span class="text-xs text-muted-foreground">Year (optional)</span>
            <input
              type="number" min="1" max="9999" placeholder="YYYY"
              class={`${inputClass} w-20`}
              value={yearDraft()}
              onInput={(e) => setYearDraft(e.currentTarget.value)}
              onKeyDown={onKey}
            />
          </label>
          <button
            class="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent mb-0.5"
            onMouseDown={(e) => e.preventDefault()}
            onClick={cancel}
            title="Cancel"
          >
            <IconClose class="w-3.5 h-3.5" />
          </button>
        </div>
      </Show>
    </div>
  );
}

const EMAIL_PLATFORMS = new Set(["google-calendar", "google-chat"]);

function ContactProfileFields(props: {
  contact: Contact;
  identities: ContactIdentity[];
  onUpdate: (updates: Record<string, string | null>) => void;
}) {
  const emails = () => {
    const result: string[] = [];
    for (const id of props.identities ?? []) {
      if (EMAIL_PLATFORMS.has(id.platform) && id.platform_id.includes("@")) {
        if (!result.includes(id.platform_id)) result.push(id.platform_id);
      }
    }
    return result;
  };

  const phones = () => {
    const result: string[] = [];
    for (const id of props.identities ?? []) {
      if (id.platform === "phone") {
        if (!result.includes(id.platform_id)) result.push(id.platform_id);
      }
    }
    return result;
  };

  return (
    <div class="mb-6">
      <div class="flex items-center gap-2 mb-2">
        <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Profile</h2>
        <span class="h-px flex-1 bg-border" />
      </div>
      <div class="bg-card rounded-sm p-3">
        <BirthdayField
          value={props.contact.date_of_birth}
          onSave={(v) => props.onUpdate({ dateOfBirth: v })}
        />
        <For each={emails()}>
          {(email) => (
            <div class="flex items-center gap-2 py-1.5">
              <span class="text-sm text-muted-foreground w-20 shrink-0">Email</span>
              <span class="text-sm truncate">{email}</span>
            </div>
          )}
        </For>
        <For each={phones()}>
          {(phone) => (
            <div class="flex items-center gap-2 py-1.5">
              <span class="text-sm text-muted-foreground w-20 shrink-0">Phone</span>
              <span class="text-sm truncate">{phone}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function ContactNotes(props: {
  contact: Contact;
  onUpdate: (notes: string) => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const startEditing = () => {
    setDraft(props.contact.notes ?? "");
    setEditing(true);
  };

  const save = () => {
    props.onUpdate(draft());
    setEditing(false);
  };

  return (
    <div class="mb-6">
      <div class="flex items-center gap-2 mb-2">
        <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes</h2>
        <span class="h-px flex-1 bg-border" />
      </div>
      <Show
        when={editing()}
        fallback={
          <button
            class="w-full text-left p-3 rounded-sm bg-card hover:bg-accent transition-colors text-sm min-h-[60px]"
            onClick={startEditing}
          >
            {props.contact.notes || <span class="text-muted-foreground">Add notes...</span>}
          </button>
        }
      >
        <div class="bg-card rounded-sm p-3">
          <textarea
            class="w-full bg-transparent text-sm resize-none outline-none min-h-[80px]"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
            }}
            autofocus
          />
          <div class="flex justify-end gap-2 mt-2">
            <button
              class="px-2 py-1 text-xs border border-border rounded hover:bg-accent"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
              onClick={save}
            >
              Save
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function ContactMemories(props: {
  memories: ContactMemoryType[];
  contactId: number;
  onAdd: (content: string) => Promise<unknown>;
  onDelete: (memoryId: number) => Promise<unknown>;
}) {
  const [adding, setAdding] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const handleAdd = async () => {
    const content = draft().trim();
    if (!content) return;
    await props.onAdd(content);
    setDraft("");
    setAdding(false);
  };

  return (
    <div class="mb-6">
      <div class="flex items-center gap-2 mb-2">
        <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Memories
          <Show when={props.memories.length > 0}>
            <span class="ml-2 text-sm font-normal text-muted-foreground">({props.memories.length})</span>
          </Show>
        </h2>
        <span class="h-px flex-1 bg-border" />
        <button
          class="text-sm text-primary hover:underline"
          onClick={() => setAdding(true)}
        >
          + Add
        </button>
      </div>

      <Show when={adding()}>
        <div class="mb-3 p-3 bg-card rounded-sm">
          <input
            type="text"
            class="w-full bg-transparent text-sm outline-none"
            placeholder="Enter a fact or memory..."
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
              if (e.key === "Escape") { setAdding(false); setDraft(""); }
            }}
            autofocus
          />
          <div class="flex justify-end gap-2 mt-2">
            <button
              class="px-2 py-1 text-xs border border-border rounded hover:bg-accent"
              onClick={() => { setAdding(false); setDraft(""); }}
            >
              Cancel
            </button>
            <button
              class="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
              onClick={handleAdd}
            >
              Save
            </button>
          </div>
        </div>
      </Show>

      <div class="space-y-2">
        <For each={props.memories} fallback={
          <Show when={!adding()}>
            <p class="text-sm text-muted-foreground">No memories yet. AI assistants can store facts here via MCP.</p>
          </Show>
        }>
          {(memory) => (
            <div class="flex items-start gap-2 p-2 rounded-sm bg-card group">
              <div class="flex-1 min-w-0">
                <p class="text-sm">{memory.content}</p>
                <p class="text-xs text-muted-foreground mt-0.5">
                  {new Date(memory.created_at).toLocaleDateString()}
                </p>
              </div>
              <button
                class="text-xs text-muted-foreground hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                onClick={() => props.onDelete(memory.id)}
              >
                Delete
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
