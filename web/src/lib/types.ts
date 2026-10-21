export interface TimelineEvent {
  id: number;
  source: string;
  source_id: string | null;
  source_account: string | null;
  type: string;
  timestamp: string | Date | null;  // Eden auto-converts ISO strings to Date
  end_timestamp: string | Date | null;  // Eden auto-converts ISO strings to Date
  duration_ms: number | null;
  title: string | null;
  content: string | null;
  latitude: number | null;
  longitude: number | null;
  location_name: string | null;
  people: string | null;
  tags: string | null;
  raw_data: string;
  imported_at: string;
  import_batch: string | null;
  conversation_id: string | null;
  source_deleted_observed_at?: string | null;
  // Count of captured earlier versions (edits observed by sync); only
  // populated on conversation endpoints.
  version_count?: number;
  forwarded_from?: {
    event_id: number;
    conversation_id: string;
    timestamp: string | null;
    source_name: string | null;
    source_icon_url: string | null;
  };
  replied_to?: {
    event_id?: number;
    conversation_id?: string;
    author_name: string | null;
    content: string | null;
    has_attachment: boolean;
  };
}

export interface SearchResult {
  events: TimelineEvent[];
  count: number;
  nextCursor: string | null;
}

// Conversation pane that can be opened alongside the timeline
export interface TimelineConversationPane {
  id: string;
  conversationId: string;
  conversationTitle: string;
  conversationSource: string;
  conversationSourceAccount?: string;
  focusEventId?: number;  // Event ID to center the view around
}

// Contact types
export interface Contact {
  id: number;
  display_name: string;
  notes: string | null;
  date_of_birth: string | null;
  hidden: number;       // 0 = visible, 1 = hidden
  is_self: number;      // 1 = this contact is the user (at most one)
  created_at: string;
  updated_at: string;
}

export interface ContactMemory {
  id: number;
  contact_id: number;
  content: string;
  created_at: string;
}

export interface ContactWithStats extends Contact {
  identityCount: number;
  eventCount: number;
  avatarUrl: string | null;
}

export interface ContactIdentity {
  id: number;
  platform: string;
  platform_id: string;
  display_name: string | null;
  username: string | null;
  contact_id: number | null;
  skipped: number;
  first_seen: string;
  last_seen: string;
  avatar_url: string | null;
}

export interface UnlinkedIdentity {
  identifier: string;
  platform: string;
  platformId: string;
  displayName: string | null;
  username: string | null;
  eventCount: number;
  avatarUrl: string | null;
}

export interface SkippedIdentity {
  identifier: string;
  platform: string;
  platformId: string;
  displayName: string | null;
  username: string | null;
  eventCount: number;
  avatarUrl: string | null;
}

export interface LinkSuggestion {
  identity: {
    identifier: string;
    platform: string;
    platformId: string;
    displayName: string | null;
    username: string | null;
    eventCount: number;
    avatarUrl: string | null;
  };
  contact: {
    id: number;
    displayName: string;
    identityCount: number;
    eventCount: number;
  };
  matchedVia: string;
}
