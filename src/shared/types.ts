/**
 * Minimal event interface for grouping functions.
 * Works with both the full TimelineEvent from db/schema.ts
 * and the web app's TimelineEvent from lib/types.ts.
 */
export interface GroupableEvent {
  id: number;
  source: string;
  type: string;
  title: string | null;
  conversation_id: string | null;
  timestamp: string | Date | null;
  people: string | null;
  duration_ms: number | null;
  content: string | null;
  location_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/**
 * A person appearing in an event's `people` list, as returned alongside events
 * by the timeline and conversation endpoints and used to seed the web app's
 * identity cache.
 */
export interface EventParticipant {
  name: string;
  contactId: number | null;
  avatarUrl: string | null;
  isSelf: boolean;
}
