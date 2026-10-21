// Sync orchestrator types

import type { SyncConfig } from "./config";
import type { LocalWorkGate } from "../jobs/local-work";

export interface SyncOptions {
  verbose: boolean;
  config: SyncConfig;
  signal?: AbortSignal;
  localWork?: LocalWorkGate;
}

export interface SyncResult {
  source: string;
  success: boolean;
  /**
   * True when a guard deliberately deferred the run (e.g. on a blocked network).
   * `success` stays true — a deferral is healthy, not a failure — so this is a
   * distinct outcome rather than `success: false`.
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
  events_added: number;
  events_updated: number;
  error: string | null;
  duration_ms: number | null;
  metadata: string | null; // JSON string
}
