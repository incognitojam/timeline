// Sync orchestrator types

import type { SyncConfig } from "./config";
import type { LocalWorkGate } from "../jobs/local-work";

export interface SyncOptions {
  verbose: boolean;
  config: SyncConfig;
  signal?: AbortSignal;
  localWork?: LocalWorkGate;
  /** The source's resolved schedule interval (see resolveSyncIntervalMs). */
  intervalMs?: number;
}

export interface SyncResult {
  source: string;
  success: boolean;
  /**
   * True when a guard deliberately deferred the run (e.g. on a blocked network),
   * or the source itself found nothing to do; it then says why in
   * `metadata.skipReason`, and its sync_log row folds like a guard's (see
   * recordSkippedSync). `success` stays true — a deferral is healthy, not a
   * failure — so this is a distinct outcome rather than `success: false`.
   */
  skipped?: boolean;
  eventsAdded: number;
  eventsUpdated: number;
  error?: string;
  durationMs: number;
  /** Source-specific metadata (e.g., backup size, deleted count) */
  metadata?: Record<string, unknown>;
}

interface SyncSourceConfigFieldBase {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
}

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

export interface SyncSource {
  /** Unique identifier for the sync source (e.g., "monzo", "discord") */
  name: string;

  /** Human-readable description */
  description: string;

  /** Whether this source is enabled for sync */
  enabled: boolean;

  /** Interval when none is stored for this source, instead of `scheduler.default_interval`. */
  defaultInterval?: string;

  /** Editable per-source settings exposed by the API and web UI. */
  configSchema?: SyncSourceConfigField[];

  /** Local-only OAuth credential status for the sync dashboard, when applicable. */
  authStatus?: () => import("../lib/oauth-tokens").OAuthAuthStatus;

  /**
   * Check if sync can run (e.g., credentials exist, DB accessible, path configured).
   * Returns a message if sync cannot run, null if it can.
   * @param config - Optional source config from config.toml
   */
  canSync(config?: Record<string, unknown>): Promise<string | null>;

  /**
   * Run the sync operation.
   * Should handle its own error catching and return a SyncResult.
   */
  sync(options: SyncOptions): Promise<SyncResult>;
}

// Sync log entry stored in app-state.db
export interface SyncLogEntry {
  id: number;
  job_id: number | null;
  source: string;
  started_at: string;
  finished_at: string | null;
  success: number; // SQLite boolean
  skipped: number; // SQLite boolean — guard deferral (distinct from success/failure)
  /** Scheduled skips this row stands for (see recordSkippedSync); NULL counts as one run. */
  repeat_count: number | null;
  events_added: number;
  events_updated: number;
  error: string | null;
  duration_ms: number | null;
  metadata: string | null; // JSON string
}

/** One stored conversation a {@link ConversationRefresh} can sync on its own. */
export interface RefreshTarget {
  account: string;
  conversationId: string;
}

export type RefreshCheck = { ok: true; target: RefreshTarget } | { ok: false; reason: string };

/**
 * Syncs one stored conversation instead of a whole source: new messages only,
 * from the conversation's established cursor. See src/sync/refresh.ts.
 */
export interface ConversationRefresh {
  /** The event source whose conversations this refreshes. */
  source: string;
  /** The sync source whose job runs the refresh; it must be enabled and able to sync. */
  syncSource: SyncSource;
  /**
   * Resolve a displayed conversation to a target, or say why it can't be
   * refreshed. Runs in the API, and again in the worker before the refresh.
   */
  resolve(args: {
    conversationId: string;
    /** Distinct accounts with stored events in the conversation (at most two). */
    accounts: string[];
    settings: Record<string, unknown> | undefined;
  }): RefreshCheck;
  /** Runs in the worker's serial lane, which holds the local-work gate throughout. */
  run(target: RefreshTarget, options: SyncOptions): Promise<SyncResult>;
}
