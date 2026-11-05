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
}

/** Everything the web app may know about a platform. Plain data, so it stays web-safe. */
export interface PlatformMeta {
  id: string;
  color: string;
  sources: readonly PlatformSource[];
  /** Namespaces this platform uses in `identities.platform` and `platform:id` identifiers. */
  identityPlatforms?: readonly string[];
}
