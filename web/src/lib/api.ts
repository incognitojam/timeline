import type { ConversationRangeExportFormat } from "@shared/conversation-export";
import type { MusicPeriod, MusicRankingsOverview, MusicRecentResponse } from "@shared/music";
import type { NetworkSettings } from "@shared/network-settings";
import type { ReleaseStatus } from "@shared/releases";
import type { TimelineServiceStatus, VersionInfo } from "@shared/version";
import type { EventParticipant } from "@shared/types";
import type {
  AttachmentDescriptionHistoryPoint,
  AttachmentDescriptionHistoryResponse,
  AttachmentDetail,
  AttachmentDescriptionEntry,
  AttachmentListItem,
  AttachmentsListResponse,
  AttachmentsStats,
  AttachmentStatus,
  DescribeAttachmentRequest,
  DescribeAttachmentResponse,
} from "@shared/attachments";
import { INVALID_CONTACT_FILTER_MESSAGE, parseContactFilterId } from "./query-parser";
export type {
  AttachmentDescriptionHistoryPoint,
  AttachmentDescriptionHistoryResponse,
  AttachmentDetail,
  AttachmentDescriptionEntry,
  AttachmentListItem,
  AttachmentsListResponse,
  AttachmentsStats,
  AttachmentStatus,
  DescribeAttachmentRequest,
  DescribeAttachmentResponse,
};
export type { VersionInfo };
import type { Contact, ContactIdentity, ContactMemory, ContactWithStats, LinkSuggestion, SkippedIdentity, TimelineEvent, UnlinkedIdentity } from "./types";

// Contact API helpers
const API_BASE = typeof window !== "undefined" ? "" : "http://localhost:3001";

// ============================================================================
// Auth API
// ============================================================================

export interface AuthStatus {
  authenticated: boolean;
  authEnabled: boolean;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${API_BASE}/api/auth/status`, {
    credentials: "include",
  });
  return parseAuthStatus(res);
}

async function parseAuthStatus(res: Response): Promise<AuthStatus> {
  if (!res.ok) throw new Error("Failed to check authentication status");

  const data: unknown = await res.json();
  if (
    typeof data !== "object" ||
    data === null ||
    !("authenticated" in data) ||
    typeof data.authenticated !== "boolean" ||
    !("authEnabled" in data) ||
    typeof data.authEnabled !== "boolean"
  ) {
    throw new Error("Invalid authentication status response");
  }

  return {
    authenticated: data.authenticated,
    authEnabled: data.authEnabled,
  };
}

export async function login(password: string): Promise<{ success?: boolean; error?: string }> {
  // Use Basic Auth to authenticate - server sets cookie on success
  const res = await fetch(`${API_BASE}/api/auth/status`, {
    headers: { Authorization: "Basic " + btoa(":" + password) },
    credentials: "include",
  });
  const data = await parseAuthStatus(res);
  return data.authenticated ? { success: true } : { error: "Invalid password" };
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

// ============================================================================
// Fetch wrapper with credentials and 401 handling
// ============================================================================

async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    credentials: "include",
  });

  // Dispatch event on 401 so App.tsx can show login form
  if (res.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("auth:required"));
  }

  return res;
}

async function parseApiJson<T>(res: Response, fallbackError: string): Promise<T> {
  const data = await res.json() as T & { error?: unknown };
  if (!res.ok || data.error !== undefined) {
    throw new Error(typeof data.error === "string" ? data.error : fallbackError);
  }
  return data;
}

// ============================================================================
// Stats API
// ============================================================================

export interface StatsData {
  total_events: number;
  sources: { source: string; type: string; count: number }[];
  date_range: { earliest: string | null; latest: string | null };
}

export async function fetchStats(): Promise<StatsData> {
  const res = await apiFetch(`${API_BASE}/api/stats`);
  return res.json();
}

// ============================================================================
// Day API
// ============================================================================

export interface DayContextData {
  date: string;
  centerTimestamp: string;
  events: TimelineEvent[];
  attachments?: Record<number, Attachment[]>;
  summary: {
    totalEvents: number;
    bySource: { source: string; count: number }[];
    byType: { type: string; count: number }[];
    timeRange: { earliest: string | null; latest: string | null };
  };
}

export async function fetchDayEvents(options: {
  date?: string;
  eventId?: number;
  timestamp?: string;
  signal: AbortSignal;
}): Promise<DayContextData> {
  const params = new URLSearchParams();
  if (options.date) params.set("date", options.date);
  if (options.eventId) params.set("eventId", String(options.eventId));
  if (options.timestamp) params.set("timestamp", options.timestamp);
  const res = await apiFetch(`${API_BASE}/api/day?${params}`, { signal: options.signal });
  const data = await res.json() as unknown;
  const error = data && typeof data === "object" && "error" in data
    ? (data as { error?: unknown }).error
    : undefined;
  if (!res.ok || error !== undefined) {
    const message = typeof error === "string" ? error : "Failed to fetch day events";
    throw new Error(message);
  }
  return data as DayContextData;
}

// ============================================================================
// Conversation API
// ============================================================================

export interface ConversationListItem {
  source: string;
  sourceAccount: string | null;
  conversationId: string;
  title: string;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

export async function fetchConversations(params: {
  search?: string;
  source?: string;
  limit?: number;
  offset?: number;
  signal: AbortSignal;
}): Promise<{ conversations: ConversationListItem[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.search) searchParams.set("search", params.search);
  if (params?.source) searchParams.set("source", params.source);
  if (params?.limit) searchParams.set("limit", String(params.limit));
  if (params?.offset) searchParams.set("offset", String(params.offset));
  const res = await apiFetch(`${API_BASE}/api/conversations?${searchParams}`, { signal: params?.signal });
  return parseApiJson(res, "Failed to fetch conversations");
}

export async function fetchConversationSources(signal: AbortSignal): Promise<{ sources: string[] }> {
  const res = await apiFetch(`${API_BASE}/api/conversations/sources`, { signal });
  return parseApiJson(res, "Failed to fetch conversation sources");
}

export interface ConversationResponse {
  title: string;
  events: TimelineEvent[];
  attachments?: Record<string, Attachment[]>;
  nextCursor: string | null;
  participants?: Record<string, EventParticipant>;
  server: ConversationServerBreadcrumb | null;
}

export interface ConversationAroundResponse {
  title: string;
  events: TimelineEvent[];
  attachments?: Record<string, Attachment[]>;
  hasBefore: boolean;
  hasAfter: boolean;
  beforeCursor: string | null;
  afterCursor: string | null;
  participants?: Record<string, EventParticipant>;
  server: ConversationServerBreadcrumb | null;
}

export interface ConversationServerBreadcrumb {
  source: "discord";
  id: string;
  name: string | null;
}

export function createTimelineEventCursor(event: Pick<TimelineEvent, "timestamp" | "id">): string | null {
  if (!event.timestamp) return null;
  const timestamp = event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp;
  return `${timestamp}_${event.id}`;
}

export interface ConversationTitleHistory {
  title: string;
  firstSeen: string;
  lastSeen: string;
  messageCount: number;
}

export interface ConversationModelUsage {
  model: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null; // null = model has no published API pricing
}

export interface ConversationTokenUsage {
  assistantMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number | null;
  byModel: ConversationModelUsage[];
}

export interface ConversationStats {
  totalMessages: number;
  firstMessage: string | null;
  lastMessage: string | null;
  firstEventId: number | null;
  lastEventId: number | null;
  participants: { identifier: string; name: string; contactId: number | null; avatarUrl: string | null; count: number }[];
  attachmentCount: number;
  activityByMonth: { month: string; count: number }[];
  titles: ConversationTitleHistory[];
  tokenUsage: ConversationTokenUsage | null;
}

export interface ConversationParams {
  conversationId: string;
  source: string;
  sourceAccount?: string;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
  signal: AbortSignal;
}

export async function fetchConversation(options: ConversationParams): Promise<ConversationResponse> {
  const params = new URLSearchParams();
  params.set("conversationId", options.conversationId);
  params.set("source", options.source);
  if (options.sourceAccount) params.set("sourceAccount", options.sourceAccount);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.order) params.set("order", options.order);
  const res = await apiFetch(`${API_BASE}/api/conversation?${params}`, {
    signal: options.signal,
  });
  return parseApiJson(res, "Failed to fetch conversation");
}

export interface ConversationAroundParams {
  conversationId: string;
  source: string;
  sourceAccount?: string;
  eventId: number;
  before?: number;
  after?: number;
  signal: AbortSignal;
}

export async function fetchConversationAround(options: ConversationAroundParams): Promise<ConversationAroundResponse> {
  const params = new URLSearchParams();
  params.set("conversationId", options.conversationId);
  params.set("source", options.source);
  if (options.sourceAccount) params.set("sourceAccount", options.sourceAccount);
  params.set("eventId", String(options.eventId));
  if (options.before) params.set("before", String(options.before));
  if (options.after) params.set("after", String(options.after));
  const res = await apiFetch(`${API_BASE}/api/conversation/around?${params}`, {
    signal: options.signal,
  });
  return parseApiJson(res, "Failed to fetch conversation window");
}

export async function fetchConversationStats(options: {
  conversationId: string;
  source: string;
  sourceAccount?: string;
  signal: AbortSignal;
}): Promise<ConversationStats> {
  const params = new URLSearchParams();
  params.set("conversationId", options.conversationId);
  params.set("source", options.source);
  if (options.sourceAccount) params.set("sourceAccount", options.sourceAccount);
  const res = await apiFetch(`${API_BASE}/api/conversation/stats?${params}`, {
    signal: options.signal,
  });
  return parseApiJson(res, "Failed to fetch conversation stats");
}

export interface ConversationRangeExportResponse {
  text: string;
  eventCount: number;
  tokenCount: number;
  range: {
    startEventId: number;
    endEventId: number;
    requestedStartEventId: number;
    requestedEndEventId: number;
    source: string;
    sourceAccount: string | null;
    conversationId: string | null;
    title: string | null;
    startTimestamp: string | null;
    endTimestamp: string | null;
  };
}

export interface ConversationRangeExportRequest {
  startEventId: number;
  endEventId: number;
  format?: Partial<ConversationRangeExportFormat>;
}

export function resolveConversationRangeExportRequest(
  options: ConversationRangeExportRequest,
): ConversationRangeExportRequest {
  const timeZone = options.format?.timeZone ?? getBrowserTimeZone();
  if (!timeZone) return options;
  return {
    ...options,
    format: { ...options.format, timeZone },
  };
}

export async function exportConversationRange(
  options: ConversationRangeExportRequest,
  signal: AbortSignal,
): Promise<ConversationRangeExportResponse> {
  const request = resolveConversationRangeExportRequest(options);
  const res = await apiFetch(`${API_BASE}/api/conversation/export-range`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Failed to export conversation range");
  }
  return data;
}

function getBrowserTimeZone(): string | undefined {
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") return undefined;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZone || undefined;
}

// ============================================================================
// Discord Servers API
// ============================================================================

export interface DiscordServerSummary {
  guildId: string;
  name: string;
  /** Discord CDN URL for the guild icon, or null when the guild has no icon. */
  iconUrl: string | null;
  channelCount: number;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

export interface DiscordServerChannel {
  conversationId: string;
  name: string;
  /** Full conversation title. */
  title: string;
  lastEventId: number;
  isThread: boolean;
  messageCount: number;
  lastMessage: string | null;
}

export interface DiscordServerCategory {
  name: string | null;
  channels: DiscordServerChannel[];
  messageCount: number;
}

export interface DiscordServerParticipant {
  identifier: string;
  name: string;
  contactId: number | null;
  avatarUrl: string | null;
  count: number;
}

export interface DiscordServerEmoji {
  emojiId: string;
  name: string;
  animated: boolean;
  imageUrl: string;
}

export interface DiscordServerEmojiUploader {
  uploaderId: string | null;
  identifier: string | null;
  name: string;
  contactId: number | null;
  avatarUrl: string | null;
  count: number;
  emojis: DiscordServerEmoji[];
}

export interface DiscordServerDetail {
  guildId: string;
  name: string;
  /** Discord CDN URL for the guild icon, or null when the guild has no icon. */
  iconUrl: string | null;
  channelCount: number;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
  categories: DiscordServerCategory[];
  participants: DiscordServerParticipant[];
  activityByMonth: { month: string; count: number }[];
  emojiCount: number;
  emojiUploaders: DiscordServerEmojiUploader[];
}

export async function fetchDiscordServers(signal: AbortSignal): Promise<{ servers: DiscordServerSummary[] }> {
  const res = await apiFetch(`${API_BASE}/api/discord/servers`, { signal });
  return parseApiJson(res, "Failed to fetch Discord servers");
}

export async function fetchDiscordServer(
  guildId: string,
): Promise<DiscordServerDetail | { error: string }> {
  const res = await apiFetch(`${API_BASE}/api/discord/servers/${encodeURIComponent(guildId)}`);
  return res.json();
}

// ============================================================================
// Contact API
// ============================================================================

export async function fetchContacts(options: {
  includeHidden?: boolean;
  signal: AbortSignal;
}): Promise<ContactWithStats[]> {
  const params = new URLSearchParams();
  if (options?.includeHidden) params.set("includeHidden", "true");
  const res = await apiFetch(`${API_BASE}/api/contacts?${params}`, { signal: options?.signal });
  const data = await parseApiJson<{ contacts: ContactWithStats[] }>(
    res,
    "Failed to fetch contacts",
  );
  return data.contacts;
}

export async function fetchContact(id: number, signal: AbortSignal): Promise<{ contact: Contact; identities: ContactIdentity[]; avatarUrl: string | null; memories: ContactMemory[] } | null> {
  const res = await apiFetch(`${API_BASE}/api/contacts/${id}`, { signal });
  const data = await res.json();
  if (data.error) return null;
  return data;
}

export async function createContact(displayName: string, notes?: string): Promise<Contact> {
  const res = await apiFetch(`${API_BASE}/api/contacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName, notes }),
  });
  const data = await res.json();
  return data.contact;
}

export async function updateContact(
  id: number,
  updates: {
    displayName?: string;
    notes?: string;
    hidden?: boolean;
    dateOfBirth?: string | null;
    isSelf?: boolean;
  }
): Promise<Contact> {
  const res = await apiFetch(`${API_BASE}/api/contacts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  const data = await parseApiJson<{ contact: Contact }>(res, "Failed to update contact");
  return data.contact;
}

export async function deleteContact(id: number): Promise<void> {
  await apiFetch(`${API_BASE}/api/contacts/${id}`, { method: "DELETE" });
}

export async function createContactMemory(contactId: number, content: string): Promise<ContactMemory> {
  const res = await apiFetch(`${API_BASE}/api/contacts/${contactId}/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  const data = await res.json();
  return data.memory;
}

export async function deleteContactMemory(contactId: number, memoryId: number): Promise<void> {
  await apiFetch(`${API_BASE}/api/contacts/${contactId}/memories/${memoryId}`, { method: "DELETE" });
}

export async function linkIdentity(identifier: string, contactId: number): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/identities/${encodeURIComponent(identifier)}/link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contactId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to link identity");
  }
}

export interface BatchLinkResult {
  success: boolean;
  linked: number;
  errors: Array<{ identifier: string; error: string }>;
}

export async function batchLinkIdentities(
  links: Array<{ identifier: string; contactId: number }>
): Promise<BatchLinkResult> {
  const res = await apiFetch(`${API_BASE}/api/identities/batch-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ links }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to batch link identities");
  }
  return res.json();
}

export async function unlinkIdentity(identifier: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/identities/${encodeURIComponent(identifier)}/unlink`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to unlink identity");
  }
}

export async function fetchUnlinkedIdentities(options: {
  platform?: string;
  limit?: number;
  signal: AbortSignal;
}): Promise<UnlinkedIdentity[]> {
  const params = new URLSearchParams();
  if (options?.platform) params.set("platform", options.platform);
  if (options?.limit) params.set("limit", String(options.limit));
  const res = await apiFetch(`${API_BASE}/api/identities/unlinked?${params}`, { signal: options?.signal });
  const data = await res.json();
  return data.identities;
}

export async function fetchUnlinkedCount(): Promise<number> {
  const res = await apiFetch(`${API_BASE}/api/identities/unlinked/count`);
  const data = await res.json();
  return data.count;
}

export async function fetchContactsCount(): Promise<number> {
  const res = await apiFetch(`${API_BASE}/api/contacts/count`);
  const data = await res.json();
  return data.count;
}

export async function resolveContact(alias: string, source?: string): Promise<Contact | null> {
  const params = new URLSearchParams({ alias });
  if (source) params.set("source", source);
  const res = await apiFetch(`${API_BASE}/api/contacts/resolve?${params}`);
  const data = await res.json();
  return data.contact;
}

export async function fetchIdentityEvents(
  identifier: string,
  platform: string,
  options: { limit?: number; cursor?: string; signal: AbortSignal }
): Promise<{ events: TimelineEvent[]; count: number; nextCursor: string | null }> {
  const params = new URLSearchParams({ identifier, platform });
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.cursor) params.set("cursor", options.cursor);
  const res = await apiFetch(`${API_BASE}/api/identities/events?${params}`, { signal: options?.signal });
  return res.json();
}

export async function fetchContactEvents(
  contactId: number,
  options?: {
    source?: string;
    type?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    cursor?: string;
    signal: AbortSignal;
  }
): Promise<{ events: TimelineEvent[]; count: number; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options?.source) params.set("source", options.source);
  if (options?.type) params.set("type", options.type);
  if (options?.startDate) params.set("startDate", options.startDate);
  if (options?.endDate) params.set("endDate", options.endDate);
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.cursor) params.set("cursor", options.cursor);
  const res = await apiFetch(`${API_BASE}/api/contacts/${contactId}/events?${params}`, { signal: options?.signal });
  return res.json();
}

// Contact Spotify summary API
export interface ContactSpotifySummary {
  totalListens: number;
  firstListen: string | null;
  lastListen: string | null;
  topArtists: Array<{ name: string; listenCount: number }>;
  topTracks: Array<{ name: string; artist: string; listenCount: number }>;
}

export async function fetchContactSpotifySummary(
  contactId: number,
  signal: AbortSignal,
): Promise<{ summary: ContactSpotifySummary | null }> {
  const res = await apiFetch(`${API_BASE}/api/contacts/${contactId}/spotify-summary`, { signal });
  return res.json();
}

// Contact conversations API
export interface ContactConversation {
  source: string;
  sourceAccount: string | null;
  conversationId: string;
  title: string;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

export async function fetchContactConversations(
  contactId: number,
  signal: AbortSignal,
): Promise<{ conversations: ContactConversation[] }> {
  const res = await apiFetch(`${API_BASE}/api/contacts/${contactId}/conversations`, { signal });
  return res.json();
}

// Contact suggestions API
export interface ContactSuggestion {
  alias: string;
  source: string;
  normalized: string;
  matched_alias: string;
  matched_source: string;
}

export async function fetchContactSuggestions(
  contactId: number,
  signal: AbortSignal,
): Promise<{ suggestions: ContactSuggestion[]; count: number }> {
  const res = await apiFetch(`${API_BASE}/api/contacts/${contactId}/suggestions`, { signal });
  return res.json();
}

export interface SuggestedContactForIdentity {
  contactId: number;
  contactName: string;
  matchedIdentity: string;
  normalized: string;
}

export async function fetchSuggestedContactsForIdentity(
  identifier: string,
  signal: AbortSignal,
): Promise<{ suggestions: SuggestedContactForIdentity[] }> {
  const res = await apiFetch(
    `${API_BASE}/api/identities/${encodeURIComponent(identifier)}/suggested-contacts`,
    { signal },
  );
  return res.json();
}

export async function fetchLinkSuggestions(
  limit: number | undefined,
  signal: AbortSignal,
): Promise<{ suggestions: LinkSuggestion[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  const res = await apiFetch(
    `${API_BASE}/api/identities/link-suggestions${params.toString() ? `?${params}` : ""}`,
    { signal },
  );
  return res.json();
}

// ============================================================================
// Manual Events API
// ============================================================================

export interface ManualEventInput {
  timestamp: string;
  title: string;
  content?: string;
  /** Contact IDs */
  people?: number[];
  /** Origin tracking - defaults to 'user' for UI-created events */
  source_account?: string;
  /** Additional metadata stored in raw_data.origin */
  origin?: Record<string, unknown>;
}

export async function createManualEvent(input: ManualEventInput): Promise<TimelineEvent> {
  const res = await apiFetch(`${API_BASE}/api/events/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to create event");
  }
  const data = await res.json();
  return data.event;
}

export async function updateManualEvent(
  id: number,
  input: Partial<{ [K in keyof Omit<ManualEventInput, "source_account" | "origin">]: ManualEventInput[K] | null }>
): Promise<TimelineEvent> {
  const res = await apiFetch(`${API_BASE}/api/events/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to update event");
  }
  const data = await res.json();
  return data.event;
}

export async function deleteManualEvent(id: number): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/events/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to delete event");
  }
}

/**
 * Fetch a single event by id. Returns null on 404, throws on other errors.
 */
export async function fetchEvent(id: number): Promise<TimelineEvent | null> {
  const res = await apiFetch(`${API_BASE}/api/events/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to fetch event");
  }
  const data = await res.json();
  return data.event;
}

// ============================================================================
// Journal API
// ============================================================================

export interface JournalQuestion {
  question: string;
  category: string;
  group_ids?: string[];
  answered?: boolean;
  answer?: string;
  event_id?: number;
}

export interface ContextGroup {
  id: string;
  source: string;
  label: string;
  summary: string;
  eventCount: number;
  timeRange: { start: string | null; end: string | null };
  participants?: string[];
}

export interface JournalState {
  date: string;
  questions: JournalQuestion[];
  contextGroups: Record<string, ContextGroup>;
  reflection: { content: string; event_id: number } | null;
  cached: boolean;
}

export async function fetchJournalState(
  date: string,
  model: string | undefined,
  signal: AbortSignal,
): Promise<JournalState> {
  const params = new URLSearchParams();
  if (model) params.set("model", model);
  const res = await apiFetch(`${API_BASE}/api/journal/${date}?${params}`, { signal });
  return res.json();
}

export async function saveJournalAnswer(
  date: string,
  question: string,
  answer: string,
  questionIndex: number,
  questionCategory: string,
  model?: string,
  groupIds?: string[],
  eventId?: number,
): Promise<{ event: TimelineEvent }> {
  const res = await apiFetch(`${API_BASE}/api/journal/${date}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      answer,
      question_index: questionIndex,
      question_category: questionCategory,
      model,
      group_ids: groupIds,
      event_id: eventId,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to save answer");
  }
  return res.json();
}

export async function saveJournalReflection(
  date: string,
  answer: string,
  model?: string,
): Promise<{ event: TimelineEvent }> {
  const res = await apiFetch(`${API_BASE}/api/journal/${date}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "journal:reflection",
      question: "Daily Reflection",
      answer,
      question_index: -1,
      question_category: "reflection",
      model,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to save reflection");
  }
  return res.json();
}

// ============================================================================
// Transport Events API
// ============================================================================

export interface TransportLocation {
  name?: string;
  code?: string;
}

export interface TransportEventInput {
  mode: string;
  origin: TransportLocation;
  destination: TransportLocation;
  departure: string;
  arrival?: string | null;
  service?: string | null;
  operator?: string | null;
  people?: number[] | null;
  notes?: string | null;
}

export async function createTransportEvent(input: TransportEventInput): Promise<TimelineEvent> {
  const res = await apiFetch(`${API_BASE}/api/events/transport`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to create transport event");
  }
  const data = await res.json();
  return data.event;
}

export async function updateTransportEvent(
  id: number,
  input: Partial<TransportEventInput>,
): Promise<TimelineEvent> {
  const res = await apiFetch(`${API_BASE}/api/events/transport/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Failed to update transport event");
  }
  const data = await res.json();
  return data.event;
}

// Skipped identities API
export async function fetchSkippedIdentities(signal: AbortSignal): Promise<SkippedIdentity[]> {
  const res = await apiFetch(`${API_BASE}/api/identities/skipped`, { signal });
  const data = await res.json();
  return data.identities;
}

export async function fetchSkippedCount(): Promise<number> {
  const res = await apiFetch(`${API_BASE}/api/identities/skipped/count`);
  const data = await res.json();
  return data.count;
}

export async function skipIdentityApi(identifier: string, platform: string): Promise<void> {
  await apiFetch(`${API_BASE}/api/identities/skip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, platform }),
  });
}

export async function unskipIdentityApi(identifier: string, platform: string): Promise<void> {
  await apiFetch(`${API_BASE}/api/identities/unskip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, platform }),
  });
}

export async function refreshCache(): Promise<void> {
  await apiFetch(`${API_BASE}/api/cache/refresh`, {
    method: "POST",
  });
}

// Attachments API
export interface Attachment {
  id: number;
  event_id: number;
  source: string;
  source_id: string | null;
  filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  storage_path: string | null;
  status: AttachmentStatus;
  width: number | null;
  height: number | null;
  thumbhash: string | null;
  description: string | null;
}

export async function fetchEventAttachments(eventId: number): Promise<Attachment[]> {
  const res = await apiFetch(`${API_BASE}/api/events/${eventId}/attachments`);
  const data = await res.json();
  return data.attachments || [];
}

export interface ConversationMediaAttachment extends Attachment {
  file_size: number | null;
  duration_ms: number | null;
  timestamp: string;
}

export interface ConversationMediaParams {
  conversationId: string;
  source: string;
  sourceAccount?: string;
  mime?: string;
  limit?: number;
  cursor?: string;
  signal: AbortSignal;
}

export interface ConversationMediaResponse {
  attachments: ConversationMediaAttachment[];
  nextCursor: string | null;
}

export async function fetchConversationMedia(params: ConversationMediaParams): Promise<ConversationMediaResponse> {
  const searchParams = new URLSearchParams();
  searchParams.set("conversationId", params.conversationId);
  searchParams.set("source", params.source);
  if (params.sourceAccount) searchParams.set("sourceAccount", params.sourceAccount);
  if (params.mime) searchParams.set("mime", params.mime);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.cursor) searchParams.set("cursor", params.cursor);
  const res = await apiFetch(`${API_BASE}/api/conversation/media?${searchParams}`, {
    signal: params.signal,
  });
  return parseApiJson(res, "Failed to fetch conversation media");
}

// Global attachments browser API
export interface AttachmentsListParams {
  limit?: number;
  cursor?: string;
  mime?: "image" | "video" | "audio";
  source?: string;
  excludeSources?: readonly string[];
  described?: boolean;
  status?: AttachmentStatus;
  signal: AbortSignal;
}

export async function fetchAttachments(params: AttachmentsListParams): Promise<AttachmentsListResponse> {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.mime) searchParams.set("mime", params.mime);
  if (params.source) searchParams.set("source", params.source);
  if (params.excludeSources) searchParams.set("exclude_sources", params.excludeSources.join(","));
  if (params.described !== undefined) searchParams.set("described", String(params.described));
  if (params.status) searchParams.set("status", params.status);
  const res = await apiFetch(`${API_BASE}/api/attachments?${searchParams}`, {
    signal: params.signal,
  });
  return parseApiJson(res, "Failed to fetch attachments");
}

export async function fetchAttachmentsStats(signal: AbortSignal): Promise<AttachmentsStats> {
  const res = await apiFetch(`${API_BASE}/api/attachments/stats`, { signal });
  return parseApiJson(res, "Failed to fetch attachment stats");
}

export async function fetchAttachmentDescriptionHistory(
  signal: AbortSignal,
): Promise<AttachmentDescriptionHistoryResponse> {
  const res = await apiFetch(`${API_BASE}/api/attachments/description-history`, { signal });
  return parseApiJson(res, "Failed to fetch attachment description history");
}

export async function fetchAttachmentDetail(id: number, signal: AbortSignal): Promise<AttachmentDetail> {
  const res = await apiFetch(`${API_BASE}/api/attachments/${id}`, { signal });
  return parseApiJson(res, "Failed to fetch attachment");
}

export async function describeAttachment(
  id: number,
  body: DescribeAttachmentRequest,
): Promise<DescribeAttachmentResponse> {
  const res = await apiFetch(`${API_BASE}/api/attachments/${id}/describe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseApiJson(res, "Failed to generate description");
}

// WakaTime / Coding Activity API
export interface WakaTimeStats {
  totalDuration: number;
  sessionCount: number;
  avgSessionDuration: number;
  dateRange: { start: string | null; end: string | null };
  byProject: Array<{ name: string; duration: number; sessionCount: number }>;
  byLanguage: Array<{ name: string; duration: number }>;
  byBranch: Array<{ name: string; duration: number }>;
  byDay: Array<{ date: string; duration: number }>;
}

export type WakaTimePreset = "today" | "yesterday" | "7d" | "30d" | "year" | "all";

export interface WakaTimeProjectStats {
  project: {
    name: string;
    totalDuration: number;
    sessionCount: number;
    firstActivity: string | null;
    lastActivity: string | null;
  };
  byLanguage: Array<{ name: string; duration: number }>;
  byBranch: Array<{ name: string; duration: number }>;
  byDay: Array<{ date: string; duration: number }>;
  activityByMonth: Array<{ month: string; duration: number }>;
}

export async function fetchWakaTimeStats(options: {
  startDate?: string;
  endDate?: string;
  preset?: WakaTimePreset;
  signal: AbortSignal;
}): Promise<WakaTimeStats> {
  const params = new URLSearchParams();
  if (options?.startDate) params.set("startDate", options.startDate);
  if (options?.endDate) params.set("endDate", options.endDate);
  if (options?.preset) params.set("preset", options.preset);
  const res = await apiFetch(`${API_BASE}/api/wakatime/stats?${params}`, { signal: options?.signal });
  return parseApiJson(res, "Failed to fetch WakaTime stats");
}

export async function fetchWakaTimeProject(
  name: string,
  options: { startDate?: string; endDate?: string; signal: AbortSignal }
): Promise<WakaTimeProjectStats | { error: string }> {
  const params = new URLSearchParams();
  if (options?.startDate) params.set("startDate", options.startDate);
  if (options?.endDate) params.set("endDate", options.endDate);
  const res = await apiFetch(`${API_BASE}/api/wakatime/projects/${encodeURIComponent(name)}?${params}`, { signal: options?.signal });
  if (res.status === 404) {
    const data = await res.json() as { error?: unknown };
    if (typeof data.error !== "string") {
      throw new Error("Failed to fetch WakaTime project");
    }
    return { error: data.error };
  }
  return parseApiJson(res, "Failed to fetch WakaTime project");
}

export async function fetchWakaTimeProjectSessions(
  name: string,
  options: {
    startDate?: string;
    endDate?: string;
    limit?: number;
    cursor?: string;
    order?: "asc" | "desc";
    signal: AbortSignal;
  }
): Promise<{ sessions: TimelineEvent[]; count: number; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options?.startDate) params.set("startDate", options.startDate);
  if (options?.endDate) params.set("endDate", options.endDate);
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.order) params.set("order", options.order);
  const res = await apiFetch(`${API_BASE}/api/wakatime/projects/${encodeURIComponent(name)}/sessions?${params}`, { signal: options?.signal });
  return parseApiJson(res, "Failed to fetch WakaTime project sessions");
}

export interface CodingProject {
  name: string;
  primaryLanguage: string | null;
  totalDuration: number;
  sessionCount: number;
  conversationCount: number;
  messageCount: number;
  aiSources: string[];
  firstActivity: string | null;
  lastActivity: string | null;
}

export async function fetchCodingProjects(options: {
  search?: string;
  limit?: number;
  signal: AbortSignal;
}): Promise<{ projects: CodingProject[] }> {
  const params = new URLSearchParams();
  if (options?.search) params.set("search", options.search);
  if (options?.limit) params.set("limit", String(options.limit));
  const res = await apiFetch(`${API_BASE}/api/coding/projects?${params}`, { signal: options?.signal });
  return parseApiJson(res, "Failed to fetch coding projects");
}

export interface CodingProjectConversation {
  source: string;
  sourceAccount: string | null;
  conversationId: string | null;
  title: string;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
  lastEventId: number;
}

export async function fetchCodingProjectConversations(
  name: string,
  options: { limit?: number; offset?: number; signal: AbortSignal }
): Promise<{ conversations: CodingProjectConversation[]; total: number }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.offset) params.set("offset", String(options.offset));
  const res = await apiFetch(`${API_BASE}/api/coding/projects/${encodeURIComponent(name)}/conversations?${params}`, { signal: options?.signal });
  return parseApiJson(res, "Failed to fetch coding project conversations");
}

// Map API helpers
export interface MapEvent {
  id: number;
  latitude: number;
  longitude: number;
  location_name: string | null;
  title: string | null;
  type: string;
  source: string;
  timestamp: string;
}

export async function fetchMapEventsForDay(
  date: string,
  types: string[] | undefined,
  signal: AbortSignal,
): Promise<{ events: MapEvent[]; count: number }> {
  const params = new URLSearchParams();
  if (types && types.length > 0) {
    params.set("types", types.join(","));
  }
  const res = await apiFetch(`${API_BASE}/api/map/day/${date}?${params}`, { signal });
  return res.json();
}

// Search params type for the search API
export interface SearchParams {
  text?: string;
  source?: string;
  type?: string;
  startDate?: string;
  endDate?: string;
  chat?: string;
  contact?: string;
  location?: string;
  from?: string;
  sort?: string;
}

// Search results type
export interface SearchResult {
  events: TimelineEvent[];
  count: number;
  nextCursor: string | null;
}

// Fetch search results with parsed query and optional cursor
export async function fetchSearch(
  parsed: SearchParams,
  cursor: string | undefined,
  options: { includeNoisySources?: boolean; signal: AbortSignal }
): Promise<SearchResult> {
  const queryParams: Record<string, string | undefined> = {
    limit: "50",
    cursor,
    // An empty exclude_sources overrides the server's default noisy-source
    // excludes; leaving it unset keeps them applied.
    exclude_sources: options?.includeNoisySources ? "" : undefined,
  };

  if (parsed.text) queryParams.q = parsed.text;
  if (parsed.source) queryParams.source = parsed.source;
  if (parsed.type) queryParams.type = parsed.type;
  if (parsed.startDate) queryParams.startDate = parsed.startDate;
  if (parsed.endDate) queryParams.endDate = parsed.endDate;
  if (parsed.chat) queryParams.chat = parsed.chat;
  if (parsed.sort) queryParams.sort = parsed.sort;

  // Handle contact filter - fetch from contact events endpoint
  if (parsed.contact !== undefined) {
    const contactId = parseContactFilterId(parsed.contact);
    if (contactId === undefined) {
      throw new Error(INVALID_CONTACT_FILTER_MESSAGE);
    }
    const res = await apiFetch(`${API_BASE}/api/contacts/${contactId}/events?${new URLSearchParams({
      limit: "50",
      ...(parsed.text && { q: parsed.text }),
      ...(parsed.source && { source: parsed.source }),
      ...(parsed.type && { type: parsed.type }),
      ...(parsed.startDate && { startDate: parsed.startDate }),
      ...(parsed.endDate && { endDate: parsed.endDate }),
      ...(parsed.chat && { chat: parsed.chat }),
      ...(parsed.sort && { sort: parsed.sort }),
      ...(cursor && { cursor }),
    })}`, { signal: options?.signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return {
      events: (data.events ?? []) as TimelineEvent[],
      count: data.count ?? 0,
      nextCursor: data.nextCursor ?? null,
    };
  }

  if (parsed.location) {
    const res = await apiFetch(`${API_BASE}/api/location?${new URLSearchParams({
      name: parsed.location,
      limit: "100",
    })}`, { signal: options?.signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return { events: data.events ?? [], count: data.count ?? 0, nextCursor: null };
  }

  if (parsed.from) {
    queryParams.q = queryParams.q ? `${queryParams.q} ${parsed.from}` : parsed.from;
  }

  const hasFilters = Object.entries(queryParams).some(
    ([k, v]) => v !== undefined && k !== "limit" && k !== "cursor" && k !== "exclude_sources"
  );

  if (!hasFilters) {
    const res = await apiFetch(`${API_BASE}/api/recent?${new URLSearchParams(
      Object.fromEntries(Object.entries(queryParams).filter(([_, v]) => v !== undefined)) as Record<string, string>
    )}`, { signal: options?.signal });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return {
      events: (data.events ?? []) as TimelineEvent[],
      count: data.count ?? 0,
      nextCursor: data.nextCursor ?? null,
    };
  }

  const res = await apiFetch(`${API_BASE}/api/search?${new URLSearchParams(
    Object.fromEntries(Object.entries(queryParams).filter(([_, v]) => v !== undefined)) as Record<string, string>
  )}`, { signal: options?.signal });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return {
    events: (data.events ?? []) as TimelineEvent[],
    count: data.count ?? 0,
    nextCursor: data.nextCursor ?? null,
  };
}

// ============================================================================
// Retrieval eval API
// ============================================================================

export interface EvalCase {
  id: number;
  name: string;
  category: string;
  notes: string | null;
  created_at: string;
}

export interface EvalCaseSummary extends EvalCase {
  query_count: number;
  expectation_count: number;
}

export interface EvalQuery {
  id: number;
  case_id: number;
  text: string;
}

export type EvalExpectationKind = "event" | "range" | "none";

export interface EvalExpectation {
  id: number;
  case_id: number;
  kind: EvalExpectationKind;
  grade: number;
  event_id: number | null;
  source: string | null;
  event_timestamp: string | null;
  conversation_id: string | null;
  start_timestamp: string | null;
  end_timestamp: string | null;
  note: string | null;
  created_at: string;
}

export interface EvalExpectationInput {
  kind: EvalExpectationKind;
  grade?: number;
  event_id?: number;
  source?: string;
  event_timestamp?: string;
  conversation_id?: string;
  start_timestamp?: string;
  end_timestamp?: string;
  note?: string;
}

export interface EvalCaseDetail extends EvalCase {
  queries: EvalQuery[];
  expectations: EvalExpectation[];
}

export async function fetchEvalCases(signal: AbortSignal): Promise<{ cases: EvalCaseSummary[] }> {
  const res = await apiFetch(`${API_BASE}/api/eval/cases`, { signal });
  return parseApiJson(res, "Failed to fetch eval cases");
}

export async function fetchEvalCase(id: number, signal: AbortSignal): Promise<{ case: EvalCaseDetail }> {
  const res = await apiFetch(`${API_BASE}/api/eval/cases/${id}`, { signal });
  return parseApiJson(res, "Failed to fetch eval case");
}

export async function createEvalCaseApi(input: {
  name: string;
  category: string;
  notes?: string;
  queries?: string[];
}): Promise<{ case: EvalCaseDetail }> {
  const res = await apiFetch(`${API_BASE}/api/eval/cases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseApiJson(res, "Failed to create eval case");
}

export async function deleteEvalCaseApi(id: number): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/eval/cases/${id}`, { method: "DELETE" });
  await parseApiJson(res, "Failed to delete eval case");
}

export async function addEvalQueryApi(caseId: number, text: string): Promise<{ query: EvalQuery }> {
  const res = await apiFetch(`${API_BASE}/api/eval/cases/${caseId}/queries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return parseApiJson(res, "Failed to add query");
}

export async function deleteEvalQueryApi(id: number): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/eval/queries/${id}`, { method: "DELETE" });
  await parseApiJson(res, "Failed to delete query");
}

export async function addEvalExpectationApi(
  caseId: number,
  input: EvalExpectationInput
): Promise<{ expectation: EvalExpectation }> {
  const res = await apiFetch(`${API_BASE}/api/eval/cases/${caseId}/expectations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseApiJson(res, "Failed to add expectation");
}

export async function updateEvalExpectationApi(
  id: number,
  input: { grade?: number; note?: string | null }
): Promise<{ expectation: EvalExpectation }> {
  const res = await apiFetch(`${API_BASE}/api/eval/expectations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseApiJson(res, "Failed to update expectation");
}

export async function deleteEvalExpectationApi(id: number): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/eval/expectations/${id}`, { method: "DELETE" });
  await parseApiJson(res, "Failed to delete expectation");
}

/** A timeline event returned by semantic search, with its vector distance (lower = closer). */
export type SemanticSearchEvent = TimelineEvent & { distance?: number };

export async function fetchSemanticSearch(params: {
  q: string;
  limit?: number;
  includeNoisySources?: boolean;
  signal: AbortSignal;
}): Promise<{ events: SemanticSearchEvent[]; count: number }> {
  const searchParams = new URLSearchParams({ q: params.q });
  if (params.limit !== undefined) searchParams.set("limit", String(params.limit));
  // An empty exclude_sources overrides the server's default noisy-source excludes.
  if (params.includeNoisySources) searchParams.set("exclude_sources", "");
  const res = await apiFetch(`${API_BASE}/api/search/semantic?${searchParams}`, { signal: params.signal });
  const data = await res.json() as { events?: SemanticSearchEvent[]; count?: number; error?: unknown };
  if (!res.ok || data.error !== undefined) {
    throw new Error(typeof data.error === "string" ? data.error : "Semantic search failed");
  }
  return { events: data.events ?? [], count: data.count ?? 0 };
}

// ============================================================================
// Health API
// ============================================================================

export interface RollingBaselinePoint {
  date: string;
  lowerBound: number;
  upperBound: number;
}

export interface PreviousPeriodStats {
  sleep: { avgDuration: number; avgEfficiency: number; avgBedtime: number | null; avgWakeTime: number | null; avgScore: number };
  heart: { avgRestingHR: number };
  hrv: { avgRmssd: number };
  activity: { avgSteps: number; totalSteps: number };
  spo2: { avgValue: number };
  weight: { latest: number | null; change: number | null };
}

export interface HealthStats {
  dateRange: { start: string | null; end: string | null };
  sleep: {
    avgDuration: number;
    avgEfficiency: number;
    avgBedtime: number | null;
    avgWakeTime: number | null;
    avgScore: number;
    nightsTracked: number;
    byDay: { date: string; duration: number; efficiency: number; startTime?: string; endTime?: string; score: number }[];
    naps: { date: string; duration: number; startTime?: string; endTime?: string }[];
  };
  heart: {
    avgRestingHR: number;
    byDay: { date: string; restingHR: number }[];
    rollingBaseline: RollingBaselinePoint[];
  };
  hrv: {
    avgRmssd: number;
    byDay: { date: string; rmssd: number }[];
    rollingBaseline: RollingBaselinePoint[];
  };
  activity: {
    avgSteps: number;
    totalSteps: number;
    daysTracked: number;
    byDay: { date: string; steps: number }[];
  };
  spo2: {
    avgValue: number;
    byDay: { date: string; value: number }[];
    rollingBaseline: RollingBaselinePoint[];
  };
  weight: {
    latest: number | null;
    change: number | null;
    measurements: number;
    byDay: { date: string; weight: number }[];
  };
  previousPeriod?: PreviousPeriodStats;
}

export interface BiomarkerReferenceRange {
  name: string;
  level: string;
  lower_bound: number | null;
  upper_bound: number | null;
}

export interface BiomarkerData {
  id: string;
  name: string;
  category: string;
  results: {
    date: string;
    value: number;
    unit: string;
    level: string;
    referenceRanges: BiomarkerReferenceRange[];
  }[];
}

export async function fetchHealthStats(options: {
  view: "day" | "week" | "month" | "quarter" | "year";
  mode: "recent" | "calendar";
  anchor: string;
  signal: AbortSignal;
}): Promise<HealthStats> {
  const params = new URLSearchParams({
    view: options.view,
    mode: options.mode,
    anchor: options.anchor,
  });
  const res = await apiFetch(`${API_BASE}/api/health/stats?${params}`, { signal: options.signal });
  return parseApiJson(res, "Failed to fetch health stats");
}

export async function fetchBiomarkers(signal: AbortSignal): Promise<{ biomarkers: BiomarkerData[] }> {
  const res = await apiFetch(`${API_BASE}/api/health/biomarkers`, { signal });
  return parseApiJson(res, "Failed to fetch biomarkers");
}

// ============================================================================
// Day Health Stats
// ============================================================================

export type RangeStatus = "in_range" | "above" | "below";

export interface MetricWithRange {
  value: number;
  status: RangeStatus;
  personalRange: [number, number];  // [low, high] bounds
}

export interface DayHealthStats {
  date: string;
  hasData: boolean;
  activity?: {
    steps: number;
    caloriesOut: number;
    activeMinutes: number;  // fairly + very active
    floors?: number;
  };
  sleep?: {
    duration: number;       // ms
    efficiency: number;     // %
    deepMinutes?: number;
    lightMinutes?: number;
    remMinutes?: number;
    score?: {
      score: number;        // 0-100
      breakdown: {
        duration: number;
        deepSleep?: number;
        remSleep?: number;
        continuity: number;
        onsetLatency: number;
      };
      hasStageData: boolean;
    };
  };
  healthMetrics: {
    restingHR?: MetricWithRange;
    hrv?: MetricWithRange;
    spo2?: MetricWithRange;
    breathingRate?: MetricWithRange;
    skinTempVariation?: MetricWithRange;
  };
  outOfRangeCount: number;
  totalMetricCount: number;
}

export async function fetchDayHealth(date: string): Promise<DayHealthStats> {
  const res = await apiFetch(`${API_BASE}/api/day/${date}/health`);
  return res.json();
}

// ============================================================================
// Spotify Track Images API
// ============================================================================

/**
 * Fetch cached album art URLs for a list of track URIs.
 * Returns a map of track URI → image URL for tracks that have cached images.
 */
export async function fetchTrackImages(uris: string[]): Promise<Record<string, string>> {
  if (uris.length === 0) return {};
  const res = await apiFetch(`${API_BASE}/api/spotify/track-images?uris=${encodeURIComponent(uris.join(","))}`);
  return res.json();
}

// ============================================================================
// Service Status & Sync API
// ============================================================================

export interface LastSyncRun {
  time: string;
  success: boolean;
  skipped: boolean;
  isRunning: boolean;
  eventsAdded: number;
  eventsUpdated: number;
  error: string | null;
  durationMs: number;
}

export interface SchedulerSourceStatus {
  source: string;
  description: string;
  enabled: boolean;
  isRunning: boolean;
  intervalMs: number;
  lastRun: LastSyncRun | null;
  nextRunAt: string | null;
}

export interface InboxSourceStatus {
  source: string;
  filesProcessed: number;
  totalSize: number;
  totalEvents: number;
  lastProcessed: string | null;
  lastDetectedType: string | null;
}

export interface ServiceStatus {
  service: TimelineServiceStatus;
  scheduler: {
    enabled: boolean;
    sources: SchedulerSourceStatus[];
  };
  inbox: {
    enabled: boolean;
    watchedDirs: string[];
    sources: InboxSourceStatus[];
  };
  queue: Job[];
}

export interface SyncHistoryEntry {
  id: number;
  job_id: number | null;
  source: string;
  started_at: string;
  finished_at: string | null;
  success: number;
  skipped: number;
  events_added: number;
  events_updated: number;
  error: string | null;
  duration_ms: number | null;
  metadata: string | null;
}

export interface InboxSourceInfo {
  name: string;
  parser: string;
  account: string | null;
  patterns: string[];
  enabled: boolean;
}

export interface InboxSourcesResponse {
  basePath: string;
  archivePath: string | null;
  sources: InboxSourceInfo[];
}

interface SyncSourceConfigFieldBase {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
}

/** Editable per-source setting descriptor. Mirrors `SyncSourceConfigField` in src/sync/types.ts. */
export type SyncSourceConfigField =
  | (SyncSourceConfigFieldBase & {
      type: "string";
      default?: string;
      format?: "path";
    })
  | (SyncSourceConfigFieldBase & { type: "boolean"; default?: boolean })
  | (SyncSourceConfigFieldBase & { type: "string-list"; default?: string[] })
  | (SyncSourceConfigFieldBase & {
      type: "number";
      default?: number;
      integer?: boolean;
      min?: number;
      max?: number;
    })
  | (SyncSourceConfigFieldBase & { type: "select"; options: string[]; default?: string });

export type SyncSourceSettingsPatch = Record<string, string | number | boolean | string[] | null>;

export interface SyncSourceConfigurationPatch {
  enabled?: boolean;
  interval?: string | null;
  settings?: SyncSourceSettingsPatch;
}

export class SyncSourceConfigurationError extends Error {
  readonly field: string | null;

  constructor(message: string, field: string | null) {
    super(message);
    this.name = "SyncSourceConfigurationError";
    this.field = field;
  }
}

export interface SyncSourceInfo {
  name: string;
  description: string;
  configured: boolean;
  enabled: boolean;
  interval: string | null;
  effectiveInterval: string;
  effectiveIntervalMs: number;
  defaultInterval: string;
  settings: Record<string, unknown>;
  settingsSchema: SyncSourceConfigField[];
  authStatus?: "connected" | "needs-reauth" | "not-configured";
}

export interface SyncSourcesResponse {
  sources: SyncSourceInfo[];
}

export async function fetchServiceStatus(signal: AbortSignal): Promise<ServiceStatus> {
  const res = await apiFetch(`${API_BASE}/api/status`, { signal });
  return res.json();
}

export async function fetchReleaseStatus(signal: AbortSignal): Promise<ReleaseStatus> {
  const res = await apiFetch(`${API_BASE}/api/releases/latest`, { signal });
  return parseApiJson<ReleaseStatus>(res, "Failed to check releases");
}

export async function fetchNetworkSettings(signal: AbortSignal): Promise<NetworkSettings> {
  const res = await apiFetch(`${API_BASE}/api/settings/network`, { signal });
  return parseApiJson<NetworkSettings>(res, "Failed to load network settings");
}

export async function updateNetworkSettings(settings: NetworkSettings): Promise<NetworkSettings> {
  const res = await apiFetch(`${API_BASE}/api/settings/network`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  return parseApiJson<NetworkSettings>(res, "Failed to save network settings");
}

export async function fetchSyncSources(signal: AbortSignal): Promise<SyncSourcesResponse> {
  const res = await apiFetch(`${API_BASE}/api/sync/sources`, { signal });
  return res.json();
}

const syncSourceConfigurationQueue = new Map<string, Promise<void>>();

async function sendSyncSourceConfiguration(
  source: string,
  patch: SyncSourceConfigurationPatch
): Promise<SyncSourceInfo> {
  const res = await apiFetch(`${API_BASE}/api/sync/sources/${encodeURIComponent(source)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json() as unknown;
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : "Failed to update sync source configuration";
    const field = data && typeof data === "object" && "field" in data && typeof data.field === "string"
      ? data.field
      : null;
    throw new SyncSourceConfigurationError(message, field);
  }
  return data as SyncSourceInfo;
}

export async function updateSyncSourceConfiguration(
  source: string,
  patch: SyncSourceConfigurationPatch
): Promise<SyncSourceInfo> {
  const previous = syncSourceConfigurationQueue.get(source);
  const request = previous === undefined
    ? sendSyncSourceConfiguration(source, patch)
    : previous.then(() => sendSyncSourceConfiguration(source, patch));
  const settled = request.then(
    () => {},
    () => {}
  );
  syncSourceConfigurationQueue.set(source, settled);

  try {
    return await request;
  } finally {
    if (syncSourceConfigurationQueue.get(source) === settled) {
      syncSourceConfigurationQueue.delete(source);
    }
  }
}

export async function fetchSyncHistory(options: {
  source?: string;
  limit?: number;
  signal: AbortSignal;
}): Promise<{ entries: SyncHistoryEntry[]; count: number }> {
  const params = new URLSearchParams();
  if (options?.source) params.set("source", options.source);
  if (options?.limit) params.set("limit", String(options.limit));
  const res = await apiFetch(`${API_BASE}/api/status/sync-history?${params}`, { signal: options?.signal });
  return res.json();
}

export async function fetchInboxSources(signal: AbortSignal): Promise<InboxSourcesResponse> {
  const res = await apiFetch(`${API_BASE}/api/status/inbox-sources`, { signal });
  return res.json();
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type JobKind = "sync" | "inbox-process";

export interface Job {
  id: number;
  kind: JobKind;
  source: string | null;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  status: JobStatus;
  priority: number;
  attempt: number;
  maxAttempts: number;
  enqueuedAt: string;
  notBefore: string;
  startedAt: string | null;
  finishedAt: string | null;
  workerId: string | null;
  workerLeaseUntil: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  trigger: string;
}

export const TERMINAL_JOB_STATUSES: JobStatus[] = ["succeeded", "failed", "cancelled"];

export function isJobTerminal(job: Pick<Job, "status">): boolean {
  return TERMINAL_JOB_STATUSES.includes(job.status);
}

export interface TriggerSyncResponse {
  success: boolean;
  jobId?: number;
  deduped?: boolean;
  message: string;
}

export async function triggerSyncSource(source: string): Promise<TriggerSyncResponse> {
  const res = await apiFetch(`${API_BASE}/api/status/trigger-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });
  return res.json();
}

export interface UploadInboxResponse {
  success: boolean;
  filename?: string;
  jobId?: number;
  deduped?: boolean;
  message: string;
}

export async function uploadInboxFile(
  file: File,
  source: string
): Promise<UploadInboxResponse> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("source", source);
  const res = await apiFetch(`${API_BASE}/api/inbox/upload`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

export async function fetchJob(id: number): Promise<Job | null> {
  const res = await apiFetch(`${API_BASE}/api/jobs/${id}`);
  if (res.status === 404) return null;
  const json = (await res.json()) as { job: Job };
  return json.job;
}

export async function listJobs(options?: {
  status?: JobStatus | JobStatus[];
  source?: string;
  kind?: JobKind;
  limit?: number;
  offset?: number;
}): Promise<{ jobs: Job[]; count: number }> {
  const params = new URLSearchParams();
  if (options?.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    params.set("status", statuses.join(","));
  }
  if (options?.source) params.set("source", options.source);
  if (options?.kind) params.set("kind", options.kind);
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.offset) params.set("offset", String(options.offset));
  const res = await apiFetch(`${API_BASE}/api/jobs?${params}`);
  return res.json();
}

// ============================================================================
// MCP Recording API
// ============================================================================

export type McpTransport = "http" | "stdio";

export interface McpSessionSummary {
  id: string;
  transport: McpTransport;
  client_name: string | null;
  client_version: string | null;
  token_hash: string | null;
  created_at: string;
  last_activity_at: string;
  call_count: number;
  error_count: number;
  last_call_at: string | null;
}

export interface McpSession {
  id: string;
  transport: McpTransport;
  client_name: string | null;
  client_version: string | null;
  token_hash: string | null;
  created_at: string;
  last_activity_at: string;
}

export interface McpToolCall {
  id: number;
  session_id: string;
  tool_name: string;
  args_json: string | null;
  args_chars: number;
  result_text: string | null;
  result_chars: number;
  is_error: number;
  truncated: number;
  duration_ms: number;
  created_at: string;
}

export interface McpSessionStats {
  call_count: number;
  error_count: number;
  avg_duration_ms: number | null;
}

export interface McpSessionDetail {
  session: McpSession;
  calls: McpToolCall[];
  count: number;
  stats: McpSessionStats;
}

export async function fetchMcpSessions(options: {
  limit?: number;
  offset?: number;
  signal: AbortSignal;
}): Promise<{ sessions: McpSessionSummary[]; count: number }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.offset) params.set("offset", String(options.offset));
  const res = await apiFetch(`${API_BASE}/api/mcp/sessions?${params}`, { signal: options?.signal });
  return res.json();
}

export async function fetchMcpSession(
  id: string,
  options: { limit?: number; offset?: number; signal: AbortSignal },
): Promise<McpSessionDetail> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", String(options.limit));
  if (options?.offset) params.set("offset", String(options.offset));
  const res = await apiFetch(`${API_BASE}/api/mcp/sessions/${encodeURIComponent(id)}?${params}`, { signal: options?.signal });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || "Failed to fetch MCP session");
  }
  return data;
}

/**
 * Poll a job until it reaches a terminal state or the abort signal fires.
 * Resolves with the terminal job; rejects if the job is missing or aborted.
 */
export async function waitForJob(
  id: number,
  options?: { intervalMs?: number; signal?: AbortSignal; onUpdate?: (job: Job) => void }
): Promise<Job> {
  const intervalMs = options?.intervalMs ?? 1000;
  const signal = options?.signal;

  while (true) {
    if (signal?.aborted) {
      throw new DOMException("waitForJob aborted", "AbortError");
    }
    const job = await fetchJob(id);
    if (!job) {
      throw new Error(`Job ${id} not found`);
    }
    options?.onUpdate?.(job);
    if (isJobTerminal(job)) {
      return job;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, intervalMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("waitForJob aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ============================================================================
// Music / Playlists
// ============================================================================

export type { MusicPeriod, MusicRankingsOverview, MusicRecentResponse } from "@shared/music";

export interface PlaylistPoint {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface TrackedPlaylist {
  playlistId: string;
  name: string | null;
  imageUrl: string | null;
  latestCount: number;
  latestDate: string;
  firstDate: string;
  /** Best-effort playlist creation date (YYYY-MM-DD), or null if not yet known. */
  createdDate: string | null;
  observations: number;
  series: PlaylistPoint[];
}

export interface PlaylistObservationPoint extends PlaylistPoint {
  origin: string; // 'api' | 'seed'
}

export interface PlaylistDetail {
  playlistId: string;
  name: string | null;
  imageUrl: string | null;
  /** Best-effort playlist creation date (YYYY-MM-DD), or null if not yet known. */
  createdDate: string | null;
  observations: PlaylistObservationPoint[];
}

export interface SpotifyFriendLatestListen {
  eventId: number;
  person: string;
  spotifyId: string;
  contactId: number | null;
  name: string;
  avatarUrl: string | null;
  timestamp: string;
  trackName: string;
  artistName: string | null;
  albumName: string | null;
  imageUrl: string | null;
}

export async function fetchTrackedPlaylists(signal: AbortSignal): Promise<{ playlists: TrackedPlaylist[] }> {
  const res = await apiFetch(`${API_BASE}/api/playlists`, { signal });
  return parseApiJson(res, "Failed to fetch playlists");
}

export async function fetchMusicRankings(
  period: MusicPeriod,
  signal: AbortSignal,
): Promise<MusicRankingsOverview> {
  const res = await apiFetch(`${API_BASE}/api/music/rankings?period=${encodeURIComponent(period)}`, { signal });
  return parseApiJson(res, "Failed to fetch music rankings");
}

export async function fetchRecentMusicPlays(signal: AbortSignal): Promise<MusicRecentResponse> {
  const res = await apiFetch(`${API_BASE}/api/music/recent`, { signal });
  return parseApiJson(res, "Failed to fetch recent music plays");
}

export async function fetchLatestFriendListens(signal: AbortSignal): Promise<{ friends: SpotifyFriendLatestListen[] }> {
  const res = await apiFetch(`${API_BASE}/api/music/friends/latest`, { signal });
  return parseApiJson(res, "Failed to fetch latest friend listens");
}

export async function fetchPlaylistDetail(id: string, signal: AbortSignal): Promise<PlaylistDetail> {
  const res = await apiFetch(`${API_BASE}/api/playlists/${encodeURIComponent(id)}`, { signal });
  return parseApiJson(res, "Failed to fetch playlist");
}
