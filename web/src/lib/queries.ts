import type { HealthWindow } from "@shared/health-periods";
import type { MusicPeriod } from "@shared/music";
import type { NetworkSettings } from "@shared/network-settings";
import {
  createInfiniteQuery,
  createMutation,
  createQuery,
  infiniteQueryOptions as defineInfiniteQueryOptions,
  queryOptions as defineQueryOptions,
  keepPreviousData,
  useQueryClient,
} from "@tanstack/solid-query";
import {
  addEvalExpectationApi,
  addEvalQueryApi,
  type AttachmentDescriptionEntry,
  type AttachmentDetail,
  type AttachmentListItem,
  type AttachmentsListParams,
  batchLinkIdentities,
  type ConversationAroundParams,
  type ConversationMediaParams,
  type ConversationParams,
  type ConversationRangeExportRequest,
  createContact,
  createContactMemory,
  createEvalCaseApi,
  createManualEvent,
  createTransportEvent,
  type DayContextData,
  deleteContact,
  deleteContactMemory,
  deleteEvalCaseApi,
  deleteEvalExpectationApi,
  deleteEvalQueryApi,
  deleteManualEvent,
  describeAttachment,
  type DescribeAttachmentRequest,
  type EvalExpectationInput,
  exportConversationRange,
  fetchAttachmentDetail,
  fetchAttachmentDescriptionHistory,
  fetchBiomarkers,
  fetchCodingProjectConversations,
  fetchCodingProjects,
  fetchAttachments,
  fetchAttachmentsStats,
  fetchNetworkSettings,
  fetchReleaseStatus,
  fetchContact,
  fetchContactConversations,
  fetchContactEvents,
  fetchContactSpotifySummary,
  fetchContactSuggestions,
  fetchContacts,
  fetchConversation,
  fetchConversationAround,
  fetchConversationMedia,
  fetchConversationSources,
  fetchConversationStats,
  fetchConversations,
  fetchDayEvents,
  fetchDiscordServers,
  fetchEvalCase,
  fetchEvalCases,
  fetchHealthStats,
  fetchIdentityEvents,
  fetchInboxSources,
  fetchJournalState,
  fetchLatestFriendListens,
  fetchLinkSuggestions,
  fetchMapEventsForDay,
  fetchMusicRankings,
  fetchMcpSession,
  fetchMcpSessions,
  fetchPlaylistDetail,
  fetchRecentMusicPlays,
  fetchSearch,
  fetchSemanticSearch,
  fetchServiceStatus,
  fetchSkippedIdentities,
  fetchSuggestedContactsForIdentity,
  fetchSyncHistory,
  fetchSyncSources,
  fetchTrackedPlaylists,
  fetchUnlinkedIdentities,
  fetchWakaTimeProject,
  fetchWakaTimeProjectSessions,
  fetchWakaTimeStats,
  type JournalState,
  linkIdentity,
  type ManualEventInput,
  refreshCache,
  resolveConversationRangeExportRequest,
  type SearchParams,
  type ServiceStatus,
  type SyncSourceConfigurationPatch,
  type SyncSourceInfo,
  type SyncSourcesResponse,
  saveJournalAnswer,
  saveJournalReflection,
  skipIdentityApi,
  type TransportEventInput,
  triggerSyncSource,
  unlinkIdentity,
  unskipIdentityApi,
  updateContact,
  updateEvalExpectationApi,
  updateManualEvent,
  updateNetworkSettings,
  updateSyncSourceConfiguration,
  updateTransportEvent,
  uploadInboxFile,
  type WakaTimePreset,
} from "./api";
import { resolveEventsIdentities } from "./identities";
import { getToday } from "./timelineDate";
import type { Contact, ContactIdentity, ContactMemory, ContactWithStats, LinkSuggestion, SkippedIdentity, TimelineEvent, UnlinkedIdentity } from "./types";

const SYNC_REFETCH_INTERVAL_MS = 30_000;
const MAP_EVENTS_REFETCH_INTERVAL_MS = 60_000;
const CODING_PROJECT_PAGE_SIZE = 50;
const CONVERSATION_RANGE_EXPORT_STALE_TIME_MS = 60_000;
const CONVERSATION_RANGE_EXPORT_GC_TIME_MS = 2 * 60_000;

type ConversationPageParams = Omit<ConversationParams, "signal">;
type ConversationAroundQueryParams = Omit<ConversationAroundParams, "signal">;
type ConversationMediaQueryParams = Omit<ConversationMediaParams, "cursor" | "signal">;
type AttachmentsQueryParams = Omit<AttachmentsListParams, "cursor" | "signal">;

// Query keys for cache management
export const queryKeys = {
  dayEventsRoot: () => ["dayEvents"] as const,
  dayEvents: (options: { date?: string; eventId?: number; timestamp?: string }) =>
    ["dayEvents", options] as const,
  journalStateRoot: () => ["journalState"] as const,
  journalState: (date: string, model?: string) => ["journalState", date, model] as const,
  contactsRoot: () => ["contacts"] as const,
  contacts: (options?: { includeHidden?: boolean }) =>
    ["contacts", options] as const,
  contactRoot: () => ["contact"] as const,
  contact: (id: number) => ["contact", id] as const,
  contactEventsRoot: () => ["contactEvents"] as const,
  contactEvents: (id: number, options?: object) => ["contactEvents", id, options] as const,
  contactSpotifySummaryRoot: () => ["contactSpotifySummary"] as const,
  contactSpotifySummary: (id: number) => ["contactSpotifySummary", id] as const,
  contactConversationsRoot: () => ["contactConversations"] as const,
  contactConversations: (id: number) => ["contactConversations", id] as const,
  contactSuggestionsRoot: () => ["contactSuggestions"] as const,
  contactSuggestions: (id: number) => ["contactSuggestions", id] as const,
  suggestedContactsForIdentityRoot: () => ["suggestedContactsForIdentity"] as const,
  suggestedContactsForIdentity: (identifier: string) =>
    ["suggestedContactsForIdentity", identifier] as const,
  linkSuggestions: () => ["linkSuggestions"] as const,

  unlinkedIdentitiesRoot: () => ["unlinkedIdentities"] as const,
  unlinkedIdentities: (options?: { platform?: string; limit?: number }) =>
    ["unlinkedIdentities", options] as const,
  skippedIdentities: () => ["skippedIdentities"] as const,
  identityEvents: (identifier: string, platform: string, options?: object) =>
    ["identityEvents", identifier, platform, options] as const,
  searchEventsRoot: () => ["searchEvents"] as const,
  searchEvents: (params: SearchParams, includeNoisySources: boolean) =>
    ["searchEvents", params, includeNoisySources] as const,
  semanticSearch: (params: { q: string; includeNoisySources?: boolean }) =>
    ["semanticSearch", params] as const,
  conversationsRoot: () => ["conversations"] as const,
  conversations: (params?: { search?: string; source?: string; limit?: number; offset?: number }) =>
    ["conversations", params] as const,
  conversationSources: () => ["conversationSources"] as const,
  conversationPage: (params: ConversationPageParams) =>
    ["conversation", "page", params] as const,
  conversationAround: (params: ConversationAroundQueryParams) =>
    ["conversation", "around", params] as const,
  conversationMedia: (params: ConversationMediaQueryParams) =>
    ["conversation", "media", params] as const,
  conversationRangeExport: (params: ConversationRangeExportRequest | undefined) =>
    ["conversation", "rangeExport", params] as const,
  conversationStats: (params: { conversationId: string; source: string; sourceAccount?: string }) =>
    ["conversationStats", params] as const,
  attachmentsList: () => ["attachments", "list"] as const,
  attachments: (params: AttachmentsQueryParams) => [...queryKeys.attachmentsList(), params] as const,
  attachmentsStats: () => ["attachments", "stats"] as const,
  attachmentDescriptionHistory: () => ["attachments", "description-history"] as const,
  attachmentDetail: (id: number) => ["attachments", "detail", id] as const,
  musicPlaylists: () => ["music", "playlists"] as const,
  musicRankings: (period: MusicPeriod) => ["music", "rankings", period] as const,
  musicRecent: () => ["music", "recent"] as const,
  musicFriendListens: () => ["music", "friends", "latest"] as const,
  musicPlaylist: (playlistId: string) => ["music", "playlist", playlistId] as const,
  healthStats: (window: HealthWindow) => ["health", "stats", window] as const,
  healthBiomarkers: () => ["health", "biomarkers"] as const,
  codingStats: (preset: WakaTimePreset) => ["coding", "stats", preset] as const,
  codingProjects: (options?: { search?: string; limit?: number }) =>
    ["coding", "projects", options] as const,
  codingProject: (name: string) => ["codingProject", "stats", name] as const,
  codingProjectSessions: (name: string) => ["codingProject", "sessions", name] as const,
  codingProjectConversations: (name: string) =>
    ["codingProject", "conversations", name] as const,
  discordServers: () => ["discordServers"] as const,
  mapEventsRoot: () => ["map-events"] as const,
  mapEventsForDay: (date: string, types?: string[]) => ["map-events", date, types] as const,
  serviceStatus: () => ["serviceStatus"] as const,
  releaseStatus: () => ["releaseStatus"] as const,
  networkSettings: () => ["networkSettings"] as const,
  syncSources: () => ["syncSources"] as const,
  syncHistoryRoot: () => ["syncHistory"] as const,
  syncHistory: (params?: { source?: string; limit?: number }) =>
    ["syncHistory", params] as const,
  inboxSources: () => ["inboxSources"] as const,
  mcpSessions: (params?: { limit?: number; offset?: number }) =>
    ["mcpSessions", params] as const,
  mcpSession: (id: string | undefined, params?: { limit?: number; offset?: number }) =>
    ["mcpSession", id, params] as const,
  evalCasesRoot: () => ["evalCases"] as const,
  evalCases: () => ["evalCases", "list"] as const,
  evalCase: (id: number | undefined) => ["evalCases", "detail", id] as const,
};

// Re-export SearchParams type for convenience
export type { SearchParams };

export const queryOptions = {
  dayEvents: (options: { date?: string; eventId?: number; timestamp?: string }) =>
    defineQueryOptions({
      queryKey: queryKeys.dayEvents(options),
      queryFn: async ({ signal }) => {
        const data = await fetchDayEvents({ ...options, signal });
        await resolveEventsIdentities(data.events);
        return data;
      },
      enabled: options.date !== undefined || options.eventId !== undefined || options.timestamp !== undefined,
      placeholderData: keepPreviousData,
    }),

  journalState: (date: string, model: string | null | undefined) =>
    defineQueryOptions({
      queryKey: queryKeys.journalState(date, model ?? undefined),
      queryFn: ({ signal }) => {
        if (!date) throw new Error("Missing journal date");
        if (!model) throw new Error("Missing journal model");
        return fetchJournalState(date, model, signal);
      },
      enabled: date !== "" && model !== null && model !== undefined,
    }),

  contacts: (options?: { includeHidden?: boolean }) =>
    defineQueryOptions({
      queryKey: queryKeys.contacts(options),
      queryFn: ({ signal }) => fetchContacts({ ...options, signal }),
    }),

  contact: (contactId: number | undefined) =>
    defineQueryOptions({
      queryKey: queryKeys.contact(contactId ?? 0),
      queryFn: ({ signal }) => {
        if (contactId === undefined) throw new Error("Missing contactId");
        return fetchContact(contactId, signal);
      },
      enabled: contactId !== undefined,
      placeholderData: keepPreviousData,
    }),

  unlinkedIdentities: (options?: { platform?: string; limit?: number }) =>
    defineQueryOptions({
      queryKey: queryKeys.unlinkedIdentities(options),
      queryFn: ({ signal }) => fetchUnlinkedIdentities({ ...options, signal }),
    }),

  skippedIdentities: () =>
    defineQueryOptions({
      queryKey: queryKeys.skippedIdentities(),
      queryFn: ({ signal }) => fetchSkippedIdentities(signal),
    }),

  contactEvents: (contactId: number | undefined, options?: { limit?: number }) =>
    defineQueryOptions({
      queryKey: queryKeys.contactEvents(contactId ?? 0, options),
      queryFn: ({ signal }) => {
        if (contactId === undefined) throw new Error("Missing contactId");
        return fetchContactEvents(contactId, { ...options, signal });
      },
      enabled: contactId !== undefined,
      placeholderData: keepPreviousData,
    }),

  contactSpotifySummary: (contactId: number | undefined) =>
    defineQueryOptions({
      queryKey: queryKeys.contactSpotifySummary(contactId ?? 0),
      queryFn: ({ signal }) => {
        if (contactId === undefined) throw new Error("Missing contactId");
        return fetchContactSpotifySummary(contactId, signal);
      },
      enabled: contactId !== undefined,
      placeholderData: keepPreviousData,
    }),

  contactConversations: (contactId: number | undefined) =>
    defineQueryOptions({
      queryKey: queryKeys.contactConversations(contactId ?? 0),
      queryFn: ({ signal }) => {
        if (contactId === undefined) throw new Error("Missing contactId");
        return fetchContactConversations(contactId, signal);
      },
      enabled: contactId !== undefined,
      placeholderData: keepPreviousData,
    }),

  contactSuggestions: (contactId: number | undefined) =>
    defineQueryOptions({
      queryKey: queryKeys.contactSuggestions(contactId ?? 0),
      queryFn: ({ signal }) => {
        if (contactId === undefined) throw new Error("Missing contactId");
        return fetchContactSuggestions(contactId, signal);
      },
      enabled: contactId !== undefined,
      placeholderData: keepPreviousData,
    }),

  suggestedContactsForIdentity: (identifier: string | undefined) =>
    defineQueryOptions({
      queryKey: queryKeys.suggestedContactsForIdentity(identifier ?? ""),
      queryFn: ({ signal }) => fetchSuggestedContactsForIdentity(identifier ?? "", signal),
      enabled: identifier !== undefined && identifier !== "",
    }),

  linkSuggestions: () =>
    defineQueryOptions({
      queryKey: queryKeys.linkSuggestions(),
      queryFn: ({ signal }) => fetchLinkSuggestions(25, signal),
    }),

  identityEvents: (
    identity: { identifier: string; platform: string } | undefined,
    options?: { limit?: number }
  ) =>
    defineQueryOptions({
      queryKey: queryKeys.identityEvents(identity?.identifier ?? "", identity?.platform ?? "", options),
      queryFn: ({ signal }) => fetchIdentityEvents(
        identity?.identifier ?? "",
        identity?.platform ?? "",
        { ...options, signal },
      ),
      enabled: identity !== undefined,
      placeholderData: keepPreviousData,
    }),

  searchEvents: (params: SearchParams, enabled: boolean, includeNoisySources = false) =>
    defineInfiniteQueryOptions({
      queryKey: queryKeys.searchEvents(params, includeNoisySources),
      queryFn: async ({ pageParam, signal }) => fetchSearch(params, pageParam, {
        includeNoisySources,
        signal,
      }),
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      initialPageParam: undefined as string | undefined,
      enabled,
      placeholderData: keepPreviousData,
    }),

  evalCases: () =>
    defineQueryOptions({
      queryKey: queryKeys.evalCases(),
      queryFn: ({ signal }) => fetchEvalCases(signal),
    }),

  evalCase: (id: number | undefined) =>
    defineQueryOptions({
      queryKey: queryKeys.evalCase(id),
      queryFn: ({ signal }) => {
        if (id === undefined) throw new Error("No eval case selected");
        return fetchEvalCase(id, signal);
      },
      enabled: id !== undefined,
      placeholderData: keepPreviousData,
    }),

  semanticSearch: (params: { q: string; includeNoisySources?: boolean }, enabled: boolean) =>
    defineQueryOptions({
      queryKey: queryKeys.semanticSearch(params),
      queryFn: async ({ signal }) => {
        const data = await fetchSemanticSearch({ ...params, signal });
        await resolveEventsIdentities(data.events);
        return data;
      },
      enabled,
      placeholderData: keepPreviousData,
      staleTime: 60_000,
      // Failures are config/provider errors that won't heal on retry; surface
      // them immediately instead of re-embedding the query three times.
      retry: false,
    }),

  conversations: (params: { search?: string; source?: string; limit?: number; offset?: number }) =>
    defineQueryOptions({
      queryKey: queryKeys.conversations(params),
      queryFn: ({ signal }) => fetchConversations({ ...params, signal }),
      placeholderData: keepPreviousData,
    }),

  conversationSources: () =>
    defineQueryOptions({
      queryKey: queryKeys.conversationSources(),
      queryFn: ({ signal }) => fetchConversationSources(signal),
    }),

  conversationPage: (params: ConversationPageParams) =>
    defineQueryOptions({
      queryKey: queryKeys.conversationPage(params),
      queryFn: ({ signal }) => fetchConversation({ ...params, signal }),
    }),

  conversationAround: (params: ConversationAroundQueryParams) =>
    defineQueryOptions({
      queryKey: queryKeys.conversationAround(params),
      queryFn: ({ signal }) => fetchConversationAround({ ...params, signal }),
    }),

  conversationMedia: (params: ConversationMediaQueryParams) =>
    defineInfiniteQueryOptions({
      queryKey: queryKeys.conversationMedia(params),
      queryFn: ({ pageParam, signal }) => fetchConversationMedia({
        ...params,
        cursor: pageParam,
        signal,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),

  conversationRangeExport: (params: ConversationRangeExportRequest | undefined) => {
    const request = params ? resolveConversationRangeExportRequest(params) : undefined;
    return defineQueryOptions({
      queryKey: queryKeys.conversationRangeExport(request),
      queryFn: ({ signal }) => {
        if (!request) throw new Error("Missing conversation export range");
        return exportConversationRange(request, signal);
      },
      enabled: request !== undefined,
      staleTime: CONVERSATION_RANGE_EXPORT_STALE_TIME_MS,
      gcTime: CONVERSATION_RANGE_EXPORT_GC_TIME_MS,
    });
  },

  conversationStats: (params: { conversationId: string; source: string; sourceAccount?: string }) =>
    defineQueryOptions({
      queryKey: queryKeys.conversationStats(params),
      queryFn: ({ signal }) => fetchConversationStats({ ...params, signal }),
    }),

  attachments: (params: AttachmentsQueryParams) =>
    defineInfiniteQueryOptions({
      queryKey: queryKeys.attachments(params),
      queryFn: ({ pageParam, signal }) => fetchAttachments({
        ...params,
        cursor: pageParam,
        signal,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),

  attachmentsStats: () =>
    defineQueryOptions({
      queryKey: queryKeys.attachmentsStats(),
      queryFn: ({ signal }) => fetchAttachmentsStats(signal),
      staleTime: 60_000,
    }),

  attachmentDescriptionHistory: () =>
    defineQueryOptions({
      queryKey: queryKeys.attachmentDescriptionHistory(),
      queryFn: ({ signal }) => fetchAttachmentDescriptionHistory(signal),
      staleTime: 60_000,
    }),

  attachmentDetail: (
    id: number | undefined,
    enabled: boolean,
    placeholderData?: AttachmentDetail,
  ) =>
    defineQueryOptions({
      queryKey: queryKeys.attachmentDetail(id ?? 0),
      queryFn: ({ signal }) => {
        if (id === undefined) throw new Error("Missing attachment id");
        return fetchAttachmentDetail(id, signal);
      },
      enabled: enabled && id !== undefined,
      placeholderData,
    }),

  musicPlaylists: () =>
    defineQueryOptions({
      queryKey: queryKeys.musicPlaylists(),
      queryFn: ({ signal }) => fetchTrackedPlaylists(signal),
      retry: false,
    }),

  musicRankings: (period: MusicPeriod) =>
    defineQueryOptions({
      queryKey: queryKeys.musicRankings(period),
      queryFn: ({ signal }) => fetchMusicRankings(period, signal),
      retry: false,
    }),

  musicRecent: () =>
    defineQueryOptions({
      queryKey: queryKeys.musicRecent(),
      queryFn: ({ signal }) => fetchRecentMusicPlays(signal),
      retry: false,
    }),

  musicFriendListens: () =>
    defineQueryOptions({
      queryKey: queryKeys.musicFriendListens(),
      queryFn: ({ signal }) => fetchLatestFriendListens(signal),
      retry: false,
    }),

  musicPlaylist: (playlistId: string | undefined) =>
    defineQueryOptions({
      queryKey: queryKeys.musicPlaylist(playlistId ?? ""),
      queryFn: ({ signal }) => {
        if (!playlistId) throw new Error("Missing playlist id");
        return fetchPlaylistDetail(playlistId, signal);
      },
      enabled: playlistId !== undefined && playlistId !== "",
      retry: false,
    }),

  healthStats: <TWindow extends HealthWindow>(window: TWindow) =>
    defineQueryOptions({
      queryKey: queryKeys.healthStats(window),
      // Retain the resolution with placeholder data when the selected view changes.
      queryFn: async ({ signal }) => ({
        window,
        stats: await fetchHealthStats({
          view: window.view,
          mode: window.mode,
          anchor: window.anchor,
          signal,
        }),
      }),
      placeholderData: keepPreviousData,
      retry: false,
    }),

  healthBiomarkers: () =>
    defineQueryOptions({
      queryKey: queryKeys.healthBiomarkers(),
      queryFn: ({ signal }) => fetchBiomarkers(signal),
      retry: false,
    }),

  codingStats: (preset: WakaTimePreset) =>
    defineQueryOptions({
      queryKey: queryKeys.codingStats(preset),
      queryFn: ({ signal }) => fetchWakaTimeStats({ preset, signal }),
      retry: false,
    }),

  codingProjects: (options?: { search?: string; limit?: number }) =>
    defineQueryOptions({
      queryKey: queryKeys.codingProjects(options),
      queryFn: ({ signal }) => fetchCodingProjects({ ...options, signal }),
      retry: false,
    }),

  codingProject: (name: string) =>
    defineQueryOptions({
      queryKey: queryKeys.codingProject(name),
      queryFn: async ({ signal }) => {
        if (!name) throw new Error("Missing coding project name");
        const result = await fetchWakaTimeProject(name, { signal });
        return "error" in result ? null : result;
      },
      enabled: name !== "",
      retry: false,
    }),

  codingProjectSessions: (name: string) =>
    defineInfiniteQueryOptions({
      queryKey: queryKeys.codingProjectSessions(name),
      queryFn: ({ pageParam, signal }) => {
        if (!name) throw new Error("Missing coding project name");
        return fetchWakaTimeProjectSessions(name, {
          limit: CODING_PROJECT_PAGE_SIZE,
          cursor: pageParam,
          order: "desc",
          signal,
        });
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      enabled: name !== "",
      retry: false,
    }),

  codingProjectConversations: (name: string) =>
    defineInfiniteQueryOptions({
      queryKey: queryKeys.codingProjectConversations(name),
      queryFn: ({ pageParam, signal }) => {
        if (!name) throw new Error("Missing coding project name");
        return fetchCodingProjectConversations(name, {
          limit: CODING_PROJECT_PAGE_SIZE,
          offset: pageParam,
          signal,
        });
      },
      initialPageParam: 0,
      getNextPageParam: (lastPage, pages) => {
        const loaded = pages.reduce((count, page) => count + page.conversations.length, 0);
        return lastPage.conversations.length > 0 && loaded < lastPage.total
          ? loaded
          : undefined;
      },
      enabled: name !== "",
      retry: false,
    }),

  discordServers: () =>
    defineQueryOptions({
      queryKey: queryKeys.discordServers(),
      queryFn: ({ signal }) => fetchDiscordServers(signal),
      retry: false,
    }),

  mapEventsForDay: (date: string, types: string[]) =>
    defineQueryOptions({
      queryKey: queryKeys.mapEventsForDay(date, types),
      queryFn: ({ signal }) => fetchMapEventsForDay(date, types, signal),
      staleTime: MAP_EVENTS_REFETCH_INTERVAL_MS,
      refetchInterval: date === getToday() ? MAP_EVENTS_REFETCH_INTERVAL_MS : false,
      placeholderData: keepPreviousData,
    }),

  serviceStatus: () =>
    defineQueryOptions({
      queryKey: queryKeys.serviceStatus(),
      queryFn: ({ signal }) => fetchServiceStatus(signal),
      refetchInterval: SYNC_REFETCH_INTERVAL_MS,
      retry: false,
    }),

  releaseStatus: () =>
    defineQueryOptions({
      queryKey: queryKeys.releaseStatus(),
      queryFn: ({ signal }) => fetchReleaseStatus(signal),
      staleTime: 60_000,
      retry: false,
    }),

  networkSettings: () =>
    defineQueryOptions({
      queryKey: queryKeys.networkSettings(),
      queryFn: ({ signal }) => fetchNetworkSettings(signal),
    }),

  syncSources: () =>
    defineQueryOptions({
      queryKey: queryKeys.syncSources(),
      queryFn: ({ signal }) => fetchSyncSources(signal),
      retry: false,
    }),

  syncHistory: (params?: { source?: string; limit?: number }) =>
    defineQueryOptions({
      queryKey: queryKeys.syncHistory(params),
      queryFn: ({ signal }) => fetchSyncHistory({ ...params, signal }),
      refetchInterval: SYNC_REFETCH_INTERVAL_MS,
      retry: false,
    }),

  inboxSources: () =>
    defineQueryOptions({
      queryKey: queryKeys.inboxSources(),
      queryFn: ({ signal }) => fetchInboxSources(signal),
      retry: false,
    }),

  mcpSessions: (params: { limit?: number; offset?: number }) =>
    defineQueryOptions({
      queryKey: queryKeys.mcpSessions(params),
      queryFn: ({ signal }) => fetchMcpSessions({ ...params, signal }),
      placeholderData: keepPreviousData,
    }),

  mcpSession: (sessionId: string | undefined, params?: { limit?: number; offset?: number }) =>
    defineQueryOptions({
      queryKey: queryKeys.mcpSession(sessionId, params),
      queryFn: ({ signal }) => {
        if (sessionId === undefined) throw new Error("Missing MCP session id");
        return fetchMcpSession(sessionId, { ...params, signal });
      },
      enabled: sessionId !== undefined && sessionId !== "",
      placeholderData: keepPreviousData,
    }),
};

function invalidateTimelineEventQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: queryKeys.dayEventsRoot() });
  queryClient.invalidateQueries({ queryKey: queryKeys.searchEventsRoot() });
  queryClient.invalidateQueries({ queryKey: queryKeys.mapEventsRoot() });
  queryClient.invalidateQueries({ queryKey: queryKeys.conversationsRoot() });
  queryClient.invalidateQueries({ queryKey: queryKeys.contactsRoot() });
  queryClient.invalidateQueries({ queryKey: queryKeys.contactEventsRoot() });
  queryClient.invalidateQueries({ queryKey: queryKeys.journalStateRoot() });
}

const contactMembershipQueryRoots = [
  queryKeys.contactsRoot(),
  queryKeys.contactRoot(),
  queryKeys.contactEventsRoot(),
  queryKeys.contactSpotifySummaryRoot(),
  queryKeys.contactConversationsRoot(),
  queryKeys.contactSuggestionsRoot(),
  queryKeys.suggestedContactsForIdentityRoot(),
  queryKeys.linkSuggestions(),
  queryKeys.unlinkedIdentitiesRoot(),
  queryKeys.musicFriendListens(),
] as const;

/** Invalidates every query whose result is derived from identity-to-contact membership. */
function invalidateContactMembershipQueries(queryClient: ReturnType<typeof useQueryClient>) {
  for (const queryKey of contactMembershipQueryRoots) {
    queryClient.invalidateQueries({ queryKey });
  }
}

async function removeContactDetailQueries(queryClient: ReturnType<typeof useQueryClient>, contactId: number) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: queryKeys.contact(contactId) }),
    queryClient.cancelQueries({ queryKey: ["contactEvents", contactId] }),
    queryClient.cancelQueries({ queryKey: queryKeys.contactSpotifySummary(contactId) }),
    queryClient.cancelQueries({ queryKey: queryKeys.contactConversations(contactId) }),
    queryClient.cancelQueries({ queryKey: queryKeys.contactSuggestions(contactId) }),
  ]);
  queryClient.removeQueries({ queryKey: queryKeys.contact(contactId) });
  queryClient.removeQueries({ queryKey: ["contactEvents", contactId] });
  queryClient.removeQueries({ queryKey: queryKeys.contactSpotifySummary(contactId) });
  queryClient.removeQueries({ queryKey: queryKeys.contactConversations(contactId) });
  queryClient.removeQueries({ queryKey: queryKeys.contactSuggestions(contactId) });
}

function dayKeyForDate(date: string) {
  return queryKeys.dayEvents({ date });
}

function dateFromTimestamp(timestamp: string | Date | null): string | undefined {
  if (!timestamp) return undefined;
  const value = timestamp instanceof Date ? timestamp.toISOString() : timestamp;
  return value.slice(0, 10);
}

function peopleFromContactIds(contactIds: number[] | null | undefined): string | null {
  if (!contactIds || contactIds.length === 0) return null;
  return JSON.stringify(contactIds.map((id) => `contact:${id}`));
}

function optimisticManualEvent(input: ManualEventInput, id: number): TimelineEvent {
  const now = new Date().toISOString();
  return {
    id,
    source: "manual",
    source_id: `optimistic_${Math.abs(id)}`,
    source_account: input.source_account ?? "user",
    type: "note",
    timestamp: input.timestamp,
    end_timestamp: null,
    duration_ms: null,
    title: input.title,
    content: input.content ?? null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: peopleFromContactIds(input.people),
    tags: null,
    raw_data: JSON.stringify(input),
    imported_at: now,
    import_batch: null,
    conversation_id: null,
  };
}

function locationLabel(location: { name?: string; code?: string }): string {
  return location.name || location.code || "?";
}

function transportTitle(input: TransportEventInput): string {
  const isFlight = input.mode === "flight";
  const origin = isFlight && input.origin.code ? input.origin.code : locationLabel(input.origin);
  const destination = isFlight && input.destination.code ? input.destination.code : locationLabel(input.destination);
  const route = `${origin} → ${destination}`;
  return input.service ? `${input.service}: ${route}` : route;
}

function optimisticTransportEvent(input: TransportEventInput, id: number): TimelineEvent {
  const now = new Date().toISOString();
  const arrival = input.arrival ?? null;
  const durationMsValue = arrival ? new Date(arrival).getTime() - new Date(input.departure).getTime() : null;
  const durationMs = durationMsValue !== null && durationMsValue >= 0 ? durationMsValue : null;
  return {
    id,
    source: "manual",
    source_id: `optimistic_${Math.abs(id)}`,
    source_account: "user",
    type: `transport:${input.mode}`,
    timestamp: input.departure,
    end_timestamp: arrival,
    duration_ms: durationMs,
    title: transportTitle(input),
    content: input.notes ?? null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: peopleFromContactIds(input.people),
    tags: input.operator ? JSON.stringify([`operator:${input.operator}`]) : null,
    raw_data: JSON.stringify({ transport: input }),
    imported_at: now,
    import_batch: null,
    conversation_id: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function transportLocationFromUnknown(value: unknown): { name?: string; code?: string } | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name : undefined;
  const code = typeof value.code === "string" ? value.code : undefined;
  if (!name && !code) return null;
  return { name, code };
}

function transportInputFromEvent(event: TimelineEvent): TransportEventInput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(event.raw_data);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.transport)) return null;
  const transport = raw.transport;
  const origin = transportLocationFromUnknown(transport.origin);
  const destination = transportLocationFromUnknown(transport.destination);
  if (
    typeof transport.mode !== "string" ||
    typeof transport.departure !== "string" ||
    !origin ||
    !destination
  ) {
    return null;
  }
  return {
    mode: transport.mode,
    origin,
    destination,
    departure: transport.departure,
    arrival: typeof transport.arrival === "string" || transport.arrival === null ? transport.arrival : undefined,
    service: typeof transport.service === "string" || transport.service === null ? transport.service : undefined,
    operator: typeof transport.operator === "string" || transport.operator === null ? transport.operator : undefined,
    people: Array.isArray(transport.people) && transport.people.every((id) => typeof id === "number")
      ? transport.people
      : undefined,
    notes: typeof transport.notes === "string" || transport.notes === null ? transport.notes : undefined,
  };
}

function mergeTransportUpdateInput(
  input: Partial<TransportEventInput>,
  previousEvent: TimelineEvent,
): TransportEventInput | null {
  const previous = transportInputFromEvent(previousEvent);
  if (!previous) {
    if (input.mode && input.origin && input.destination && input.departure) return input as TransportEventInput;
    return null;
  }
  return {
    ...previous,
    ...input,
    origin: input.origin ?? previous.origin,
    destination: input.destination ?? previous.destination,
    departure: input.departure ?? previous.departure,
  };
}

function applyDayEventUpsert(data: DayContextData | undefined, event: TimelineEvent): DayContextData | undefined {
  if (!data) return data;
  const events = data.events.filter((item) => item.id !== event.id);
  events.push(event);
  events.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
  return {
    ...data,
    events,
    summary: {
      ...data.summary,
      totalEvents: events.length,
    },
  };
}

function applyDayEventRemoval(data: DayContextData | undefined, eventId: number): DayContextData | undefined {
  if (!data) return data;
  const events = data.events.filter((item) => item.id !== eventId);
  return {
    ...data,
    events,
    summary: {
      ...data.summary,
      totalEvents: events.length,
    },
  };
}

// Day events query
export function useDayEvents(options: () => { date?: string; eventId?: number; timestamp?: string }) {
  return createQuery(() => queryOptions.dayEvents(options()));
}

// Journal state query
export function useJournalState(date: () => string, model: () => string | null | undefined) {
  return createQuery(() => queryOptions.journalState(date(), model()));
}

// Contacts list query
export function useContacts(options?: () => { includeHidden?: boolean }) {
  return createQuery(() => queryOptions.contacts(options?.()));
}

// Single contact query
export function useContact(id: () => number | undefined) {
  return createQuery(() => queryOptions.contact(id()));
}

// Unlinked identities query
export function useUnlinkedIdentities(options?: () => { platform?: string; limit?: number }) {
  return createQuery(() => queryOptions.unlinkedIdentities(options?.()));
}

// Skipped identities query
export function useSkippedIdentities() {
  return createQuery(() => queryOptions.skippedIdentities());
}

// Contact events query
export function useContactEvents(
  id: () => number | undefined,
  options?: () => { limit?: number }
) {
  return createQuery(() => queryOptions.contactEvents(id(), options?.()));
}

// Contact Spotify summary query
export function useContactSpotifySummary(id: () => number | undefined) {
  return createQuery(() => queryOptions.contactSpotifySummary(id()));
}

// Contact conversations query
export function useContactConversations(id: () => number | undefined) {
  return createQuery(() => queryOptions.contactConversations(id()));
}

// Contact suggestions query (find unlinked identities matching a contact's identities)
export function useContactSuggestions(id: () => number | undefined) {
  return createQuery(() => queryOptions.contactSuggestions(id()));
}

// Suggested contacts for an identity (find contacts matching an unlinked identity)
export function useSuggestedContactsForIdentity(identifier: () => string | undefined) {
  return createQuery(() => queryOptions.suggestedContactsForIdentity(identifier()));
}

// Link suggestions for Unlinked view (find unlinked identities with matching contacts)
export function useLinkSuggestions() {
  return createQuery(() => queryOptions.linkSuggestions());
}


// Identity events query
export function useIdentityEvents(
  identity: () => { identifier: string; platform: string } | undefined,
  options?: () => { limit?: number }
) {
  return createQuery(() => queryOptions.identityEvents(identity(), options?.()));
}

// Search events infinite query
export function useSearchEvents(
  params: () => SearchParams,
  enabled: () => boolean,
  includeNoisySources?: () => boolean
) {
  return createInfiniteQuery(() => queryOptions.searchEvents(params(), enabled(), includeNoisySources?.()));
}

// Semantic (vector) search query
export function useSemanticSearch(
  params: () => { q: string; includeNoisySources?: boolean },
  enabled: () => boolean
) {
  return createQuery(() => queryOptions.semanticSearch(params(), enabled()));
}

// Conversations list query
export function useConversations(params: () => { search?: string; source?: string; limit?: number; offset?: number }) {
  return createQuery(() => queryOptions.conversations(params()));
}

export function useConversationSources() {
  return createQuery(() => queryOptions.conversationSources());
}

export function useConversationStats(
  params: () => { conversationId: string; source: string; sourceAccount?: string },
) {
  return createQuery(() => queryOptions.conversationStats(params()));
}

export function useConversationMedia(params: () => ConversationMediaQueryParams) {
  return createInfiniteQuery(() => queryOptions.conversationMedia(params()));
}

export function useConversationRangeExport(params: () => ConversationRangeExportRequest | undefined) {
  return createQuery(() => queryOptions.conversationRangeExport(params()));
}

export function useAttachments(params: () => AttachmentsQueryParams) {
  return createInfiniteQuery(() => queryOptions.attachments(params()));
}

export function useAttachmentsStats() {
  return createQuery(() => queryOptions.attachmentsStats());
}

export function useAttachmentDescriptionHistory() {
  return createQuery(() => queryOptions.attachmentDescriptionHistory());
}

// Single attachment detail — only fetches while the detail modal is open. A
// gallery list item can supply the preview fields while descriptions load.
export function useAttachmentDetail(
  id: () => number | undefined,
  enabled: () => boolean,
  preview?: () => AttachmentListItem | undefined,
) {
  return createQuery(() => {
    const item = preview?.();
    return queryOptions.attachmentDetail(
      id(),
      enabled(),
      item ? { ...item, descriptions: [] } : undefined,
    );
  });
}

/** Replace the entry for a model, keeping the server's newest-first ordering. */
function mergeAttachmentDescription(
  existing: AttachmentDescriptionEntry[],
  row: AttachmentDescriptionEntry,
): AttachmentDescriptionEntry[] {
  return [...existing.filter((entry) => entry.model !== row.model), row].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.model.localeCompare(a.model),
  );
}

/**
 * Generate (or regenerate) a vision-model description for an attachment. On
 * success the new row is folded into the cached detail immediately; list and
 * stats are invalidated so gallery hover text and described counts refresh.
 */
export function useDescribeAttachment(attachmentId: () => number | undefined) {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: (input: DescribeAttachmentRequest) => {
      const id = attachmentId();
      if (id === undefined) throw new Error("Missing attachment id");
      return describeAttachment(id, input);
    },
    onSuccess: (row) => {
      const id = attachmentId();
      if (id !== undefined) {
        queryClient.setQueryData<AttachmentDetail>(queryKeys.attachmentDetail(id), (old) =>
          old ? { ...old, descriptions: mergeAttachmentDescription(old.descriptions, row) } : old,
        );
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.attachmentsList() });
      queryClient.invalidateQueries({ queryKey: queryKeys.attachmentsStats() });
    },
  }));
}

export function useMusicPlaylists() {
  return createQuery(() => queryOptions.musicPlaylists());
}

export function useMusicRankings(period: () => MusicPeriod) {
  return createQuery(() => queryOptions.musicRankings(period()));
}

export function useMusicRecent() {
  return createQuery(() => queryOptions.musicRecent());
}

export function useMusicFriendListens() {
  return createQuery(() => queryOptions.musicFriendListens());
}

export function useMusicPlaylist(playlistId: () => string | undefined) {
  return createQuery(() => queryOptions.musicPlaylist(playlistId()));
}

export function useHealthStats<TWindow extends HealthWindow>(window: () => TWindow) {
  return createQuery(() => queryOptions.healthStats(window()));
}

export function useHealthBiomarkers() {
  return createQuery(() => queryOptions.healthBiomarkers());
}

export function useCodingStats(preset: () => WakaTimePreset) {
  return createQuery(() => queryOptions.codingStats(preset()));
}

export function useCodingProjects(options?: () => { search?: string; limit?: number }) {
  return createQuery(() => queryOptions.codingProjects(options?.()));
}

export function useCodingProject(name: () => string) {
  return createQuery(() => queryOptions.codingProject(name()));
}

export function useCodingProjectSessions(name: () => string) {
  return createInfiniteQuery(() => queryOptions.codingProjectSessions(name()));
}

export function useCodingProjectConversations(name: () => string) {
  return createInfiniteQuery(() => queryOptions.codingProjectConversations(name()));
}

export function useDiscordServers() {
  return createQuery(() => queryOptions.discordServers());
}

export function useMcpSessions(params: () => { limit?: number; offset?: number }) {
  return createQuery(() => queryOptions.mcpSessions(params()));
}

export function useMcpSession(
  id: () => string | undefined,
  params?: () => { limit?: number; offset?: number },
) {
  return createQuery(() => queryOptions.mcpSession(id(), params?.()));
}

export function useMapEventsForDay(date: () => string, types: () => string[]) {
  return createQuery(() => queryOptions.mapEventsForDay(date(), types()));
}

export function useServiceStatus() {
  return createQuery(() => queryOptions.serviceStatus());
}

export function useReleaseStatus() {
  return createQuery(() => queryOptions.releaseStatus());
}

export function useNetworkSettings() {
  return createQuery(() => queryOptions.networkSettings());
}

export function useSyncSources() {
  return createQuery(() => queryOptions.syncSources());
}

export function useSyncHistory(params?: () => { source?: string; limit?: number }) {
  return createQuery(() => queryOptions.syncHistory(params?.()));
}

export function useInboxSources() {
  return createQuery(() => queryOptions.inboxSources());
}

// Retrieval eval queries + mutations
export function useEvalCases() {
  return createQuery(() => queryOptions.evalCases());
}

export function useEvalCase(id: () => number | undefined) {
  return createQuery(() => queryOptions.evalCase(id()));
}

/** All eval mutations invalidate the whole eval subtree — list and details. */
function useEvalMutation<TArgs, TResult>(mutationFn: (args: TArgs) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return createMutation(() => ({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.evalCasesRoot() });
    },
  }));
}

export function useCreateEvalCase() {
  return useEvalMutation((input: { name: string; category: string; notes?: string; queries?: string[] }) =>
    createEvalCaseApi(input)
  );
}

export function useDeleteEvalCase() {
  return useEvalMutation((id: number) => deleteEvalCaseApi(id));
}

export function useAddEvalQuery() {
  return useEvalMutation(({ caseId, text }: { caseId: number; text: string }) => addEvalQueryApi(caseId, text));
}

export function useDeleteEvalQuery() {
  return useEvalMutation((id: number) => deleteEvalQueryApi(id));
}

export function useAddEvalExpectation() {
  return useEvalMutation(({ caseId, input }: { caseId: number; input: EvalExpectationInput }) =>
    addEvalExpectationApi(caseId, input)
  );
}

export function useUpdateEvalExpectation() {
  return useEvalMutation(({ id, input }: { id: number; input: { grade?: number; note?: string | null } }) =>
    updateEvalExpectationApi(id, input)
  );
}

export function useDeleteEvalExpectation() {
  return useEvalMutation((id: number) => deleteEvalExpectationApi(id));
}

// Create contact mutation
export function useCreateContact() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ displayName, notes }: { displayName: string; notes?: string }) =>
      createContact(displayName, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contactsRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.unlinkedIdentitiesRoot() });
    },
  }));
}

// Update contact mutation with optimistic update
export function useUpdateContact() {
  const queryClient = useQueryClient();

  type ContactDetailData = {
    contact: Contact;
    identities: ContactIdentity[];
    memories: ContactMemory[];
    avatarUrl: string | null;
  };

  return createMutation(() => ({
    mutationFn: ({
      id,
      updates,
    }: {
      id: number;
      updates: {
        displayName?: string;
        notes?: string;
        hidden?: boolean;
        dateOfBirth?: string | null;
        isSelf?: boolean;
      };
    }) => updateContact(id, updates),
    onMutate: async ({ id, updates }) => {
      if (updates.isSelf !== undefined) {
        await Promise.all([
          queryClient.cancelQueries({ queryKey: queryKeys.contactRoot() }),
          queryClient.cancelQueries({ queryKey: queryKeys.contactsRoot() }),
        ]);
      } else {
        await queryClient.cancelQueries({ queryKey: queryKeys.contact(id) });
      }

      const previous = queryClient.getQueryData<ContactDetailData | null>(queryKeys.contact(id));
      const previousContactDetails = updates.isSelf === undefined
        ? []
        : queryClient.getQueriesData<ContactDetailData | null>({ queryKey: queryKeys.contactRoot() });
      const previousContactLists = updates.isSelf === undefined
        ? []
        : queryClient.getQueriesData<ContactWithStats[]>({ queryKey: queryKeys.contactsRoot() });

      if (updates.isSelf !== undefined) {
        queryClient.setQueriesData<ContactDetailData | null>(
          { queryKey: queryKeys.contactRoot() },
          (old) => old
            ? {
                ...old,
                contact: {
                  ...old.contact,
                  is_self: old.contact.id === id
                    ? (updates.isSelf ? 1 : 0)
                    : (updates.isSelf ? 0 : old.contact.is_self),
                },
              }
            : old,
        );
        queryClient.setQueriesData<ContactWithStats[]>(
          { queryKey: queryKeys.contactsRoot() },
          (old) => old?.map((contact) => ({
            ...contact,
            is_self: contact.id === id
              ? (updates.isSelf ? 1 : 0)
              : (updates.isSelf ? 0 : contact.is_self),
          })),
        );
      }

      queryClient.setQueryData(
        queryKeys.contact(id),
        (old: ContactDetailData | null | undefined) =>
          old
            ? {
                ...old,
                contact: {
                  ...old.contact,
                  display_name: updates.displayName ?? old.contact.display_name,
                  notes: updates.notes ?? old.contact.notes,
                  hidden: updates.hidden ?? old.contact.hidden,
                  ...(updates.dateOfBirth !== undefined && { date_of_birth: updates.dateOfBirth }),
                  ...(updates.isSelf !== undefined && { is_self: updates.isSelf ? 1 : 0 }),
                },
              }
            : old
      );

      return { previous, previousContactDetails, previousContactLists };
    },
    onError: (_err, { id }, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.contact(id), context.previous);
      }
      for (const [queryKey, data] of context?.previousContactDetails ?? []) {
        if (data !== undefined) queryClient.setQueryData(queryKey, data);
      }
      for (const [queryKey, data] of context?.previousContactLists ?? []) {
        if (data !== undefined) queryClient.setQueryData(queryKey, data);
      }
    },
    onSettled: (_data, _error, { id, updates }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contact(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.contactsRoot() });
      if (updates.isSelf !== undefined) {
        queryClient.invalidateQueries({ queryKey: queryKeys.contactRoot() });
      }
      if (updates.displayName !== undefined) {
        queryClient.invalidateQueries({ queryKey: queryKeys.musicFriendListens() });
      }
      if (updates.hidden !== undefined) {
        // Hiding changes what every timeline surface returns; refetch everything.
        queryClient.invalidateQueries();
      }
    },
  }));
}

// Delete contact mutation
export function useDeleteContact() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: (id: number) => deleteContact(id),
    onSuccess: async (_data, id) => {
      await removeContactDetailQueries(queryClient, id);
      queryClient.invalidateQueries({ queryKey: queryKeys.contactsRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.unlinkedIdentitiesRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.contactEventsRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.contactSuggestionsRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.musicFriendListens() });
    },
  }));
}

// Create contact memory mutation
export function useCreateContactMemory() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ contactId, content }: { contactId: number; content: string }) =>
      createContactMemory(contactId, content),
    onMutate: async ({ contactId, content }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.contact(contactId) });
      const previous = queryClient.getQueryData(queryKeys.contact(contactId));
      queryClient.setQueryData(
        queryKeys.contact(contactId),
        (old: { contact: Contact; identities: ContactIdentity[]; memories: ContactMemory[] } | null | undefined) =>
          old ? {
            ...old,
            memories: [
              { id: -Date.now(), contact_id: contactId, content, created_at: new Date().toISOString() },
              ...old.memories,
            ],
          } : old
      );
      return { previous };
    },
    onError: (_err, { contactId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.contact(contactId), context.previous);
      }
    },
    onSettled: (_data, _error, { contactId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contact(contactId) });
    },
  }));
}

// Delete contact memory mutation
export function useDeleteContactMemory() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ contactId, memoryId }: { contactId: number; memoryId: number }) =>
      deleteContactMemory(contactId, memoryId),
    onMutate: async ({ contactId, memoryId }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.contact(contactId) });
      const previous = queryClient.getQueryData(queryKeys.contact(contactId));
      queryClient.setQueryData(
        queryKeys.contact(contactId),
        (old: { contact: Contact; identities: ContactIdentity[]; memories: ContactMemory[] } | null | undefined) =>
          old ? { ...old, memories: old.memories.filter((m) => m.id !== memoryId) } : old
      );
      return { previous };
    },
    onError: (_err, { contactId }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.contact(contactId), context.previous);
      }
    },
    onSettled: (_data, _error, { contactId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contact(contactId) });
    },
  }));
}

// Link identity mutation with optimistic update
export function useLinkIdentity() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({
      contactId,
      identifier,
    }: {
      contactId: number;
      identifier: string;
    }) => linkIdentity(identifier, contactId),
    onMutate: async ({ identifier }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.unlinkedIdentitiesRoot() });
      await queryClient.cancelQueries({ queryKey: queryKeys.linkSuggestions() });

      // Optimistically remove identity from all cached unlinked queries
      const queries = queryClient.getQueriesData<UnlinkedIdentity[]>({
        queryKey: queryKeys.unlinkedIdentitiesRoot(),
      });

      const previousUnlinked: Array<[readonly unknown[], UnlinkedIdentity[] | undefined]> = [];
      for (const [key, data] of queries) {
        previousUnlinked.push([key, data]);
        if (data) {
          queryClient.setQueryData(
            key,
            data.filter((i) => i.identifier !== identifier)
          );
        }
      }

      // Optimistically remove from link suggestions
      const previousSuggestions = queryClient.getQueryData<{ suggestions: LinkSuggestion[] }>(
        queryKeys.linkSuggestions()
      );
      queryClient.setQueryData(queryKeys.linkSuggestions(), (old: { suggestions: LinkSuggestion[] } | undefined) => {
        if (!old) return old;
        return { suggestions: old.suggestions.filter((s) => s.identity.identifier !== identifier) };
      });

      return { previousUnlinked, previousSuggestions };
    },
    onError: (_err, _vars, context) => {
      // Rollback on error
      if (context?.previousUnlinked) {
        for (const [key, data] of context.previousUnlinked) {
          queryClient.setQueryData(key, data);
        }
      }
      if (context?.previousSuggestions) {
        queryClient.setQueryData(queryKeys.linkSuggestions(), context.previousSuggestions);
      }
    },
    onSuccess: () => {
      invalidateContactMembershipQueries(queryClient);
    },
  }));
}

// Batch link identities mutation - optimized to invalidate once for all links
export function useBatchLinkIdentities() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: (links: Array<{ identifier: string; contactId: number }>) =>
      batchLinkIdentities(links),
    onMutate: async (links) => {
      // Cancel any in-flight queries
      await queryClient.cancelQueries({ queryKey: queryKeys.unlinkedIdentitiesRoot() });
      await queryClient.cancelQueries({ queryKey: queryKeys.linkSuggestions() });

      // Optimistically remove all identities from cached unlinked queries
      const identifiers = new Set(links.map((l) => l.identifier));
      const queries = queryClient.getQueriesData<UnlinkedIdentity[]>({
        queryKey: queryKeys.unlinkedIdentitiesRoot(),
      });

      const previousUnlinked: Array<[readonly unknown[], UnlinkedIdentity[] | undefined]> = [];
      for (const [key, data] of queries) {
        previousUnlinked.push([key, data]);
        if (data) {
          queryClient.setQueryData(
            key,
            data.filter((i) => !identifiers.has(i.identifier))
          );
        }
      }

      // Optimistically remove from link suggestions
      const previousSuggestions = queryClient.getQueryData<{ suggestions: LinkSuggestion[] }>(
        queryKeys.linkSuggestions()
      );
      queryClient.setQueryData(queryKeys.linkSuggestions(), (old: { suggestions: LinkSuggestion[] } | undefined) => {
        if (!old) return old;
        return { suggestions: old.suggestions.filter((s) => !identifiers.has(s.identity.identifier)) };
      });

      return { previousUnlinked, previousSuggestions };
    },
    onError: (_err, _vars, context) => {
      // Rollback on error
      if (context?.previousUnlinked) {
        for (const [key, data] of context.previousUnlinked) {
          queryClient.setQueryData(key, data);
        }
      }
      if (context?.previousSuggestions) {
        queryClient.setQueryData(queryKeys.linkSuggestions(), context.previousSuggestions);
      }
    },
    onSuccess: () => {
      invalidateContactMembershipQueries(queryClient);
    },
  }));
}

// Unlink identity mutation
export function useUnlinkIdentity() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ identifier }: { identifier: string; contactId: number }) =>
      unlinkIdentity(identifier),
    onSuccess: () => {
      invalidateContactMembershipQueries(queryClient);
    },
  }));
}

// Skip identity mutation with optimistic update
export function useSkipIdentity() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ identifier, platform }: { identifier: string; platform: string }) =>
      skipIdentityApi(identifier, platform),
    onMutate: async ({ identifier, platform }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.unlinkedIdentitiesRoot() });
      await queryClient.cancelQueries({ queryKey: queryKeys.linkSuggestions() });

      // Get all cached unlinked queries and optimistically remove the identity
      const queries = queryClient.getQueriesData<UnlinkedIdentity[]>({
        queryKey: queryKeys.unlinkedIdentitiesRoot(),
      });

      const previousUnlinked: Array<[readonly unknown[], UnlinkedIdentity[] | undefined]> = [];
      for (const [key, data] of queries) {
        previousUnlinked.push([key, data]);
        if (data) {
          queryClient.setQueryData(
            key,
            data.filter((i) => !(i.identifier === identifier && i.platform === platform))
          );
        }
      }

      // Optimistically remove from link suggestions
      const previousSuggestions = queryClient.getQueryData<{ suggestions: LinkSuggestion[] }>(
        queryKeys.linkSuggestions()
      );
      queryClient.setQueryData(queryKeys.linkSuggestions(), (old: { suggestions: LinkSuggestion[] } | undefined) => {
        if (!old) return old;
        return { suggestions: old.suggestions.filter((s) => s.identity.identifier !== identifier) };
      });

      return { previousUnlinked, previousSuggestions };
    },
    onError: (_err, _vars, context) => {
      // Rollback all cached queries
      if (context?.previousUnlinked) {
        for (const [key, data] of context.previousUnlinked) {
          queryClient.setQueryData(key, data);
        }
      }
      if (context?.previousSuggestions) {
        queryClient.setQueryData(queryKeys.linkSuggestions(), context.previousSuggestions);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.unlinkedIdentitiesRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.skippedIdentities() });
      queryClient.invalidateQueries({ queryKey: queryKeys.contactSuggestionsRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.linkSuggestions() });
    },
  }));
}

// Unskip identity mutation with optimistic update
export function useUnskipIdentity() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ identifier, platform }: { identifier: string; platform: string }) =>
      unskipIdentityApi(identifier, platform),
    onMutate: async ({ identifier, platform }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.skippedIdentities() });

      const previous = queryClient.getQueryData<SkippedIdentity[]>(queryKeys.skippedIdentities());

      queryClient.setQueryData(queryKeys.skippedIdentities(), (old: SkippedIdentity[] | undefined) =>
        old?.filter((i) => !(i.identifier === identifier && i.platform === platform))
      );

      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.skippedIdentities(), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.unlinkedIdentitiesRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.skippedIdentities() });
    },
  }));
}

// Refresh cache mutation (full refetch)
export function useRefreshCache() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: refreshCache,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contactsRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.unlinkedIdentitiesRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.skippedIdentities() });
    },
  }));
}

export function useCreateManualEvent() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ input }: { input: ManualEventInput; date: string }) => createManualEvent(input),
    onMutate: async ({ input, date }) => {
      const key = dayKeyForDate(date);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DayContextData>(key);
      const optimistic = optimisticManualEvent(input, -Date.now());
      queryClient.setQueryData(key, (old: DayContextData | undefined) => applyDayEventUpsert(old, optimistic));
      return { key, previous, optimisticId: optimistic.id };
    },
    onError: (_err, _vars, context) => {
      if (context) {
        queryClient.setQueryData(context.key, context.previous);
      }
    },
    onSuccess: (event, _vars, context) => {
      if (context) {
        queryClient.setQueryData(context.key, (old: DayContextData | undefined) =>
          applyDayEventUpsert(applyDayEventRemoval(old, context.optimisticId), event)
        );
      }
    },
    onSettled: () => {
      invalidateTimelineEventQueries(queryClient);
    },
  }));
}

export function useUpdateManualEvent() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({
      id,
      input,
    }: {
      id: number;
      input: Partial<{ [K in keyof Omit<ManualEventInput, "source_account" | "origin">]: ManualEventInput[K] | null }>;
      previousEvent: TimelineEvent;
      date: string;
    }) => updateManualEvent(id, input),
    onMutate: async ({ input, previousEvent, date }) => {
      const oldDate = dateFromTimestamp(previousEvent.timestamp) ?? date;
      const nextTimestamp = typeof input.timestamp === "string" ? input.timestamp : previousEvent.timestamp;
      const newDate = dateFromTimestamp(nextTimestamp) ?? date;
      const keys = [dayKeyForDate(oldDate)];
      if (newDate !== oldDate) keys.push(dayKeyForDate(newDate));

      await Promise.all(keys.map((key) => queryClient.cancelQueries({ queryKey: key })));
      const previous = keys.map((key) => [key, queryClient.getQueryData<DayContextData>(key)] as const);
      const optimistic: TimelineEvent = {
        ...previousEvent,
        timestamp: input.timestamp === undefined ? previousEvent.timestamp : input.timestamp,
        title: input.title === undefined ? previousEvent.title : input.title,
        content: input.content === undefined ? previousEvent.content : input.content,
        people: input.people === undefined ? previousEvent.people : peopleFromContactIds(input.people),
      };

      queryClient.setQueryData(dayKeyForDate(oldDate), (old: DayContextData | undefined) =>
        applyDayEventRemoval(old, previousEvent.id)
      );
      queryClient.setQueryData(dayKeyForDate(newDate), (old: DayContextData | undefined) =>
        applyDayEventUpsert(old, optimistic)
      );

      return { previous };
    },
    onError: (_err, _vars, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSuccess: (event, { date, previousEvent }) => {
      const oldDate = dateFromTimestamp(previousEvent.timestamp) ?? date;
      const newDate = dateFromTimestamp(event.timestamp) ?? date;
      queryClient.setQueryData(dayKeyForDate(oldDate), (old: DayContextData | undefined) =>
        applyDayEventRemoval(old, event.id)
      );
      queryClient.setQueryData(dayKeyForDate(newDate), (old: DayContextData | undefined) =>
        applyDayEventUpsert(old, event)
      );
    },
    onSettled: () => {
      invalidateTimelineEventQueries(queryClient);
    },
  }));
}

export function useDeleteManualEvent() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({
      id,
    }: {
      id: number;
      event?: TimelineEvent;
      date?: string;
      journal?: { date: string; model?: string; questionIndex: number };
    }) => deleteManualEvent(id),
    onMutate: async ({ id, event, date, journal }) => {
      const eventDate = dateFromTimestamp(event?.timestamp ?? null) ?? date;
      const journalKey = journal ? queryKeys.journalState(journal.date, journal.model) : undefined;
      let previousJournal: JournalState | undefined;
      if (journalKey && journal) {
        await queryClient.cancelQueries({ queryKey: journalKey });
        previousJournal = queryClient.getQueryData<JournalState>(journalKey);
        queryClient.setQueryData(journalKey, (old: JournalState | undefined) =>
          old
            ? {
                ...old,
                questions: old.questions.map((question, index) =>
                  index === journal.questionIndex
                    ? { ...question, answered: false, answer: undefined, event_id: undefined }
                    : question,
                ),
              }
            : old,
        );
      }
      if (!eventDate) return { journalKey, previousJournal };
      const key = dayKeyForDate(eventDate);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DayContextData>(key);
      queryClient.setQueryData(key, (old: DayContextData | undefined) => applyDayEventRemoval(old, id));
      return { key, previous, journalKey, previousJournal };
    },
    onError: (_err, _vars, context) => {
      if (context?.key) {
        queryClient.setQueryData(context.key, context.previous);
      }
      if (context?.journalKey) {
        queryClient.setQueryData(context.journalKey, context.previousJournal);
      }
    },
    onSettled: () => {
      invalidateTimelineEventQueries(queryClient);
    },
  }));
}

export function useSaveJournalAnswer() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({
      date,
      question,
      answer,
      questionIndex,
      questionCategory,
      model,
      groupIds,
      eventId,
    }: {
      date: string;
      question: string;
      answer: string;
      questionIndex: number;
      questionCategory: string;
      model?: string;
      groupIds?: string[];
      eventId?: number;
    }) => saveJournalAnswer(date, question, answer, questionIndex, questionCategory, model, groupIds, eventId),
    onMutate: async ({ date, model, questionIndex, answer, eventId }) => {
      const key = queryKeys.journalState(date, model);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<JournalState>(key);
      queryClient.setQueryData(key, (old: JournalState | undefined) =>
        old
          ? {
              ...old,
              questions: old.questions.map((question, index) =>
                index === questionIndex
                  ? { ...question, answered: true, answer, event_id: eventId }
                  : question,
              ),
            }
          : old,
      );
      return { key, previous };
    },
    onError: (_error, _vars, context) => {
      if (context) {
        queryClient.setQueryData(context.key, context.previous);
      }
    },
    onSuccess: ({ event }, { date, model, questionIndex }) => {
      queryClient.setQueryData(queryKeys.journalState(date, model), (old: JournalState | undefined) =>
        old
          ? {
              ...old,
              questions: old.questions.map((question, index) =>
                index === questionIndex ? { ...question, event_id: event.id } : question,
              ),
            }
          : old,
      );
    },
    onSettled: () => {
      invalidateTimelineEventQueries(queryClient);
    },
  }));
}

export function useSaveJournalReflection() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ date, answer, model }: { date: string; answer: string; model?: string }) =>
      saveJournalReflection(date, answer, model),
    onSuccess: ({ event }, { date, model, answer }) => {
      queryClient.setQueryData(queryKeys.journalState(date, model), (old: JournalState | undefined) =>
        old
          ? {
              ...old,
              reflection: { content: event.content ?? answer, event_id: event.id },
            }
          : old,
      );
    },
    onSettled: () => {
      invalidateTimelineEventQueries(queryClient);
    },
  }));
}

export function useCreateTransportEvent() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ input }: { input: TransportEventInput; date: string }) => createTransportEvent(input),
    onMutate: async ({ input, date }) => {
      const key = dayKeyForDate(date);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DayContextData>(key);
      const optimistic = optimisticTransportEvent(input, -Date.now());
      queryClient.setQueryData(key, (old: DayContextData | undefined) => applyDayEventUpsert(old, optimistic));
      return { key, previous, optimisticId: optimistic.id };
    },
    onError: (_err, _vars, context) => {
      if (context) {
        queryClient.setQueryData(context.key, context.previous);
      }
    },
    onSuccess: (event, _vars, context) => {
      if (context) {
        queryClient.setQueryData(context.key, (old: DayContextData | undefined) =>
          applyDayEventUpsert(applyDayEventRemoval(old, context.optimisticId), event)
        );
      }
    },
    onSettled: () => {
      invalidateTimelineEventQueries(queryClient);
    },
  }));
}

export function useUpdateTransportEvent() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({
      id,
      input,
    }: {
      id: number;
      input: Partial<TransportEventInput>;
      previousEvent: TimelineEvent;
      date: string;
    }) => updateTransportEvent(id, input),
    onMutate: async ({ input, previousEvent, date }) => {
      const oldDate = dateFromTimestamp(previousEvent.timestamp) ?? date;
      const optimisticInput = mergeTransportUpdateInput(input, previousEvent);
      const newDate = dateFromTimestamp(input.departure ?? previousEvent.timestamp) ?? date;
      const keys = [dayKeyForDate(oldDate)];
      if (newDate !== oldDate) keys.push(dayKeyForDate(newDate));

      await Promise.all(keys.map((key) => queryClient.cancelQueries({ queryKey: key })));
      const previous = keys.map((key) => [key, queryClient.getQueryData<DayContextData>(key)] as const);
      if (optimisticInput) {
        const optimistic = {
          ...optimisticTransportEvent(optimisticInput, previousEvent.id),
          source_id: previousEvent.source_id,
          imported_at: previousEvent.imported_at,
        };

        queryClient.setQueryData(dayKeyForDate(oldDate), (old: DayContextData | undefined) =>
          applyDayEventRemoval(old, previousEvent.id)
        );
        queryClient.setQueryData(dayKeyForDate(newDate), (old: DayContextData | undefined) =>
          applyDayEventUpsert(old, optimistic)
        );
      }

      return { previous };
    },
    onError: (_err, _vars, context) => {
      for (const [key, data] of context?.previous ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSuccess: (event, { date, previousEvent }) => {
      const oldDate = dateFromTimestamp(previousEvent.timestamp) ?? date;
      const newDate = dateFromTimestamp(event.timestamp) ?? date;
      queryClient.setQueryData(dayKeyForDate(oldDate), (old: DayContextData | undefined) =>
        applyDayEventRemoval(old, event.id)
      );
      queryClient.setQueryData(dayKeyForDate(newDate), (old: DayContextData | undefined) =>
        applyDayEventUpsert(old, event)
      );
    },
    onSettled: () => {
      invalidateTimelineEventQueries(queryClient);
    },
  }));
}

export function useTriggerSyncSource() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: (source: string) => triggerSyncSource(source),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.serviceStatus() });
      queryClient.invalidateQueries({ queryKey: queryKeys.syncHistoryRoot() });
    },
  }));
}

/** The PATCH response is a serialized source entry, same shape as the GET list entries. */
function isSyncSourceInfo(value: unknown): value is SyncSourceInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { settings?: unknown }).settings === "object" &&
    Array.isArray((value as { settingsSchema?: unknown }).settingsSchema)
  );
}

export function useUpdateSyncSourceConfiguration() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ source, patch }: { source: string; patch: SyncSourceConfigurationPatch }) =>
      updateSyncSourceConfiguration(source, patch),
    onSuccess: (updated) => {
      // Write the PATCH response straight into the list cache so the form can
      // adopt the confirmed server snapshot even if the refetch fails or hangs.
      if (isSyncSourceInfo(updated)) {
        queryClient.setQueryData(
          queryKeys.syncSources(),
          (old: SyncSourcesResponse | undefined) =>
            old
              ? { ...old, sources: old.sources.map((entry) => (entry.name === updated.name ? updated : entry)) }
              : old
        );
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.serviceStatus() });
      queryClient.invalidateQueries({ queryKey: queryKeys.syncSources() });
    },
  }));
}

export function useUpdateNetworkSettings() {
  const queryClient = useQueryClient();
  return createMutation(() => ({
    mutationFn: (settings: NetworkSettings) => updateNetworkSettings(settings),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.networkSettings(), saved);
    },
  }));
}

export function useUploadInboxFile() {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ file, source }: { file: File; source: string }) => uploadInboxFile(file, source),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.serviceStatus() });
      queryClient.invalidateQueries({ queryKey: queryKeys.syncHistoryRoot() });
      queryClient.invalidateQueries({ queryKey: queryKeys.inboxSources() });
    },
  }));
}
