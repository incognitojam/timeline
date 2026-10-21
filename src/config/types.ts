/**
 * Timeline Service Configuration Types
 *
 * Unified configuration for the Timeline service, including server settings,
 * sync sources, and inbox processing.
 */

export interface ServerConfig {
  /** Host to bind to (default: "127.0.0.1") */
  host: string;
  /** Port to listen on (default: 3001) */
  port: number;
  /** Public URL the timeline web app is reachable at, e.g. "https://timeline.example.ts.net". Used to embed clickable event links in MCP tool descriptions. */
  public_url?: string;
}

export interface DatabaseConfig {
  /** Path to timeline.db (supports ~/) */
  path: string;
}

export interface SchedulerConfig {
  /** Enable the sync scheduler (default: true) */
  enabled: boolean;
  /** Default interval for sources without explicit interval */
  default_interval: string;
  /** Stagger initial runs to avoid thundering herd (default: true) */
  stagger: boolean;
}

export interface SyncSourceConfig {
  /** Account name for this source (optional - not all sources need it, e.g. backup) */
  account?: string;
  /** Whether this source is enabled (default: true) */
  enabled?: boolean;
  /** Sync interval (e.g., "15m", "1h", "6h", "1d") */
  interval?: string;
  /** Source-specific settings */
  [key: string]: unknown;
}

export interface InboxSourceConfig {
  /** Source type: 'rclone' for cloud sync, 'local' for manual drops */
  type: "rclone" | "local";
  /** For rclone: remote path (e.g., 'gdrive:SMS Backup') */
  remote?: string;
  /** Local folder path (supports ~/) */
  local: string;
  /** Parser to use for this source */
  parser: string;
  /** Account name - required for most parsers, auto-detected for google-takeout */
  account?: string;
  /** File patterns to match (glob), defaults to all files */
  patterns?: string[];
  /** Whether this source is enabled (default: true) */
  enabled?: boolean;
}

export interface InboxConfig {
  /** Enable inbox file watcher (default: true) */
  watch_enabled: boolean;
  /** Base inbox directory (supports ~/) */
  base_path: string;
  /** Archive processed files to this directory (optional) */
  archive_path?: string;
  /** Inbox source configurations */
  sources: Record<string, InboxSourceConfig>;
}

export interface MediaConfig {
  /** Path to media storage directory (supports ~/) */
  path: string;
  /** Optional Cloudflare R2 backend for durable, encrypted offsite storage */
  r2?: R2Config;
  /**
   * Soft cap on the local media cache in GiB. When set, eviction may drop the
   * oldest (by cache mtime) R2-durable blobs to keep local usage under it.
   * Unset = unbounded (the planner reports usage only).
   */
  cache_limit_gib?: number;
}

export interface R2Config {
  /** When true, new media is encrypted client-side and written through to R2. */
  enabled: boolean;
  /** Cloudflare account ID (used to build the S3 endpoint). */
  account_id: string;
  /** R2 bucket name. */
  bucket: string;
}

export interface BackupConfig {
  /**
   * Cloudflare R2 backend for encrypted, offsite database backups. Distinct
   * bucket from [media.r2] (independent lifecycle/retention) and gated on its
   * own BACKUP_ENCRYPTION_KEY so a media-key rotation can't orphan DB backups.
   */
  r2?: R2Config;
}

/** Wire protocol used to reach an LLM provider. */
export type LlmProviderKind = "openrouter" | "openai-compatible";

/**
 * A configured text-generation LLM provider. Providers are either OpenRouter
 * (hosted) or any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, ...),
 * letting day summaries and journal prompts run against local or networked
 * models. Mirrors the embeddings model-profile shape: secrets stay in the env
 * file, referenced by name via `api_key_env` rather than inlined here.
 */
export interface LlmProviderConfig {
  /** How to talk to the provider. */
  kind: LlmProviderKind;
  /**
   * Base URL for `openai-compatible` providers, e.g. "http://127.0.0.1:1234/v1".
   * Required for that kind; ignored for `openrouter` (which uses its hosted API).
   */
  base_url?: string;
  /** Name of the env var holding the API key. Optional — local servers often need none. */
  api_key_env?: string;
  /**
   * Model IDs to offer in the picker. Required for `openrouter` (its catalogue
   * is too large to enumerate). For `openai-compatible`, omit to auto-discover
   * from the server's `GET /models` endpoint at startup.
   */
  models?: string[];
  /**
   * Fallback context window (tokens), used to size how much of a day is sent
   * before chunking. Per-model windows are auto-detected where possible
   * (OpenRouter from its live API; LM Studio from its native API, using the
   * *loaded* instance's window), so this is only needed for OpenAI-compatible
   * servers that don't report their context (llama.cpp, vLLM). A detected loaded
   * window overrides it.
   */
  context_length?: number;
}

export interface LlmConfig {
  /** Text-generation providers, keyed by a short name (e.g. "openrouter", "lmstudio"). */
  providers: Record<string, LlmProviderConfig>;
}

/**
 * The embedding model used for semantic search, served by any OpenAI-compatible
 * server (LM Studio, llama.cpp's llama-server, vLLM, a hosted API). Kept apart
 * from `[llm.providers.*]` so an embedding-only server never appears among the
 * text-generation models.
 */
export interface EmbeddingsConfig {
  /** Server base URL, e.g. "http://127.0.0.1:1234/v1"; requests go to `<base_url>/embeddings`. */
  base_url: string;
  /** Model name passed to the server. */
  model: string;
  /** Vector length the model returns. */
  dimensions: number;
  /** Name of the env var holding the API key. Optional — local servers often need none. */
  api_key_env?: string;
  /** Stable handle for this model in embeddings.db; defaults to `<model>:<dimensions>`. */
  profile?: string;
  /** Text prepended to every indexed document, for models trained with task prompts. */
  document_prefix?: string;
  /** Text prepended to every search query, for models trained with task prompts. */
  query_prefix?: string;
  /** Seconds an embeddings request may take before it fails. */
  timeout_seconds?: number;
}

export interface ServiceConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  scheduler: SchedulerConfig;
  sync: Record<string, SyncSourceConfig>;
  inbox: InboxConfig;
  media: MediaConfig;
  backup: BackupConfig;
  llm: LlmConfig;
  /** Unset = semantic search is unavailable. */
  embeddings?: EmbeddingsConfig;
}

/** Largest delay accepted by JavaScript timers without clamping. */
export const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

export function isValidTimeoutDelay(delayMs: number): boolean {
  return Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= MAX_TIMEOUT_DELAY_MS;
}

/**
 * Parse an interval string (e.g., "15m", "1h", "6h", "1d") to milliseconds
 */
export function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid interval format: ${interval}. Use format like "15m", "1h", "6h", "1d"`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown interval unit: ${unit}`);
  }
}

/**
 * Format milliseconds as an interval string
 */
export function formatInterval(ms: number): string {
  if (ms >= 24 * 60 * 60 * 1000 && ms % (24 * 60 * 60 * 1000) === 0) {
    return `${ms / (24 * 60 * 60 * 1000)}d`;
  }
  if (ms >= 60 * 60 * 1000 && ms % (60 * 60 * 1000) === 0) {
    return `${ms / (60 * 60 * 1000)}h`;
  }
  if (ms >= 60 * 1000 && ms % (60 * 1000) === 0) {
    return `${ms / (60 * 1000)}m`;
  }
  return `${ms / 1000}s`;
}
