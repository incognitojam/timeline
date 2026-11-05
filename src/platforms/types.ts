/** How the rest of the app treats a source's events. */
export interface SourceTraits {
  /** Events group into conversation threads. `chat-assistant` and `coding-agent` stay out of Messages. */
  conversation?: "social" | "chat-assistant" | "coding-agent";
  /** Participants are personal contacts without being a conversation source. Social sources always are. */
  personal?: true;
  /** Events group into time-proximity sessions, or only `reaction:*` events do. */
  session?: { gapMinutes: number; reactionsOnly?: true };
  /** High-volume machine-generated events, left out of derived text and search by default. */
  noisy?: true;
  /** Hidden in the UI until the user chooses to show it. */
  defaultHidden?: true;
  /** Events record token usage. */
  aiUsage?: true;
  /** Participants are phone numbers, stored as identities on the `phone` platform. */
  phoneIdentity?: true;
  /** Events are embedded for semantic search, except any excluded types. */
  corpus?: true | { excludedTypes: readonly string[] };
}

/** One id this platform owns in `events.source` or `sync_log.source`. Persisted; never rename. */
export interface PlatformSource {
  id: string;
  label: string;
  /** Defaults to the platform's colour. */
  color?: string;
  /**
   * Types today's importers write. A trailing `*` stands for a suffix taken from
   * the source's data, such as `reaction:*`. Omitted for ids that write no events.
   */
  eventTypes?: readonly string[];
  /** Types left in older databases that no importer writes any more. */
  legacyEventTypes?: readonly string[];
  traits?: SourceTraits;
}

/** Everything the web app may know about a platform. Plain data, so it stays web-safe. */
export interface PlatformMeta {
  id: string;
  color: string;
  sources: readonly PlatformSource[];
  /** Namespaces this platform uses in `identities.platform` and `platform:id` identifiers. */
  identityPlatforms?: readonly string[];
}
