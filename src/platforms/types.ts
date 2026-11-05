/** One id this platform owns in `events.source` or `sync_log.source`. Persisted; never rename. */
export interface PlatformSource {
  id: string;
  label: string;
  /** Defaults to the platform's colour. */
  color?: string;
}

/** Everything the web app may know about a platform. Plain data, so it stays web-safe. */
export interface PlatformMeta {
  id: string;
  color: string;
  sources: readonly PlatformSource[];
}
