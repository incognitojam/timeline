import { Database } from "bun:sqlite";
import { getAppStateDbPath, getTimelineDbPath } from "./paths";

let appStateDb: Database | null = null;

export function getAppStateDb(): Database {
  if (!appStateDb) {
    const appStatePath = getAppStateDbPath(getTimelineDbPath());
    appStateDb = new Database(appStatePath);
    appStateDb.exec("PRAGMA journal_mode = WAL");
    appStateDb.exec("PRAGMA busy_timeout = 30000");
    appStateDb.exec("PRAGMA foreign_keys = ON");
    initAppStateDb(appStateDb);
  }
  return appStateDb;
}

export function initAppStateDb(db: Database) {
  // Day summaries cache
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_summaries (
      date TEXT NOT NULL,
      model TEXT NOT NULL,
      summary TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      event_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (date, model)
    )
  `);

  // Sync log - tracks automated sync operations
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      success INTEGER,
      events_added INTEGER DEFAULT 0,
      events_updated INTEGER DEFAULT 0,
      error TEXT,
      duration_ms INTEGER
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_log_source ON sync_log(source, started_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_log_started_at ON sync_log(started_at DESC)`);

  // Sync source configuration - app-state is the source of truth for per-source
  // scheduler settings after the one-time config.toml import.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_sources (
      source TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      interval TEXT,
      settings TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrations for early dev versions of sync_sources.
  try {
    db.exec(`ALTER TABLE sync_sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sync_sources ADD COLUMN interval TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sync_sources ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'`);
  } catch {}
  try {
    db.exec(`ALTER TABLE sync_sources ADD COLUMN updated_at TEXT`);
  } catch {}

  // Instance-wide settings edited from the web UI's Settings page. Values are JSON.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  migrateSourceBlockedNetworks(db);

  // Processed files - tracks which inbox files have been imported
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      import_batch TEXT,
      detected_type TEXT,
      events_added INTEGER,
      UNIQUE(source, file_hash)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_source ON processed_files(source)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_processed_hash ON processed_files(file_hash)`);

  // Migration: add detected_type and events_added if they don't exist
  try {
    db.exec(`ALTER TABLE processed_files ADD COLUMN detected_type TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE processed_files ADD COLUMN events_added INTEGER`);
  } catch {}

  // Migration: add metadata column to sync_log
  try {
    db.exec(`ALTER TABLE sync_log ADD COLUMN metadata TEXT`);
  } catch {}

  // Migration: link sync_log rows to the job that triggered them (nullable)
  try {
    db.exec(`ALTER TABLE sync_log ADD COLUMN job_id INTEGER`);
  } catch {}

  // Migration: mark guard-deferred runs (e.g. skipped on a blocked network) as a
  // distinct outcome from success/failure — success stays 1, skipped flags it.
  try {
    db.exec(`ALTER TABLE sync_log ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0`);
  } catch {}

  // Migration: add metadata column to day_summaries (JSON blob with generation stats)
  try {
    db.exec(`ALTER TABLE day_summaries ADD COLUMN metadata TEXT`);
  } catch {}

  // Migration: backfill metadata for old backup entries and zero out event counts
  // Old backup entries stored sizeMB in events_added and deleted count in events_updated
  db.exec(`
    UPDATE sync_log
    SET metadata = json_object('sizeMB', events_added, 'deleted', events_updated),
        events_added = 0,
        events_updated = 0
    WHERE source = 'backup'
      AND metadata IS NULL
      AND (events_added > 0 OR events_updated > 0)
  `)

  // Scheduler state - tracks last run and next scheduled run for each sync source
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_state (
      source TEXT PRIMARY KEY,
      last_run_at TEXT,
      next_run_at TEXT,
      interval_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Sync state - stores runtime state for sync sources (etags, timestamps, OAuth tokens)
  // This allows sources to persist state without writing to read-only config files
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      source TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Spotify resources cache - URI → name mappings for playlists, albums, artists
  // Populated from spotify-friends (has names inline) and API lookups
  db.exec(`
    CREATE TABLE IF NOT EXISTS spotify_resources (
      uri TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add image_url column for album art caching
  try {
    db.exec(`ALTER TABLE spotify_resources ADD COLUMN image_url TEXT`);
  } catch {}

  // Jobs queue - durable record of every "do this" request (sync, inbox-process, etc.)
  // Worker polls this table and runs jobs; replaces ephemeral postMessage IPC.
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      source TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 1,
      enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
      not_before TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      worker_id TEXT,
      worker_lease_until TEXT,
      result TEXT,
      error TEXT,
      trigger TEXT NOT NULL DEFAULT 'manual'
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_pickup ON jobs(status, not_before)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source, enqueued_at DESC)`);

  // Dedupe is on `queued` only — once a job is running, a new enqueue is
  // allowed to queue a follow-up. This avoids silently dropping requests
  // that arrive between the running job's findUnprocessedFiles scan and its
  // completion.
  db.exec(`DROP INDEX IF EXISTS idx_jobs_dedupe_active`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe_queued
      ON jobs(kind, dedupe_key)
      WHERE dedupe_key IS NOT NULL AND status = 'queued'
  `);

  // Journal sessions - caches AI-generated questions for journaling
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_sessions (
      date TEXT NOT NULL,
      model TEXT NOT NULL,
      questions TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (date, model)
    )
  `);

  // MCP sessions and tool calls - observability for HTTP and stdio MCP clients.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_sessions (
      id TEXT PRIMARY KEY,
      transport TEXT NOT NULL,
      client_name TEXT,
      client_version TEXT,
      token_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_sessions_activity ON mcp_sessions(last_activity_at DESC)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES mcp_sessions(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      args_json TEXT,
      args_chars INTEGER NOT NULL DEFAULT 0,
      result_text TEXT,
      result_chars INTEGER NOT NULL DEFAULT 0,
      is_error INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_calls_session ON mcp_tool_calls(session_id, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_calls_created ON mcp_tool_calls(created_at)`);

  // Retrieval eval: labelled test cases for scoring search quality. A case has
  // query phrasings (each scored separately) and graded expectations — either
  // specific events, time/conversation ranges, or "none" (negative control).
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      UNIQUE (case_id, text)
    )
  `);

  // event rows keep a (source, event_timestamp) snapshot alongside the rowid so
  // drift is detectable if events are ever re-imported or deduped.
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_expectations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('event', 'range', 'none')),
      grade INTEGER NOT NULL DEFAULT 2 CHECK (grade BETWEEN 0 AND 2),
      event_id INTEGER,
      source TEXT,
      event_timestamp TEXT,
      conversation_id TEXT,
      start_timestamp TEXT,
      end_timestamp TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_queries_case ON eval_queries(case_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eval_expectations_case ON eval_expectations(case_id)`);
}

// Day summary types and CRUD operations

export interface DaySummary {
  date: string;
  model: string;
  summary: string;
  token_count: number;
  event_count: number;
  metadata: string | null;
  created_at: string;
}

export function getCachedDaySummary(
  db: Database,
  date: string,
  model: string
): DaySummary | null {
  return db
    .prepare("SELECT * FROM day_summaries WHERE date = ? AND model = ?")
    .get(date, model) as DaySummary | null;
}

export function saveDaySummary(
  db: Database,
  summary: Omit<DaySummary, "created_at">
): void {
  db.prepare(`
    INSERT OR REPLACE INTO day_summaries (date, model, summary, token_count, event_count, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    summary.date,
    summary.model,
    summary.summary,
    summary.token_count,
    summary.event_count,
    summary.metadata
  );
}

// Blocked Wi-Fi networks

const BLOCKED_NETWORKS_KEY = "network.blocked_networks";

function parseNetworkList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

/** Wi-Fi network name patterns that sources opting into the network guard avoid. */
export function getBlockedNetworks(db: Database): string[] {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(BLOCKED_NETWORKS_KEY) as { value: string } | null;
  if (!row) return [];
  return parseNetworkList(JSON.parse(row.value), `app_settings.${BLOCKED_NETWORKS_KEY}`);
}

export function setBlockedNetworks(db: Database, networks: readonly string[]): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(BLOCKED_NETWORKS_KEY, JSON.stringify(networks));
}

/**
 * Move per-source `blocked_ssids` lists into the shared blocked-network list,
 * opting each source that had a non-empty list into `skip_blocked_networks`.
 * Matching is case-insensitive, so entries differing only in case merge.
 */
export function migrateSourceBlockedNetworks(db: Database): void {
  db.transaction(() => {
    const rows = db
      .prepare(`SELECT source, settings FROM sync_sources WHERE settings LIKE '%"blocked_ssids"%'`)
      .all() as { source: string; settings: string }[];

    const merged = getBlockedNetworks(db);
    let migrated = false;
    for (const row of rows) {
      const settings = JSON.parse(row.settings) as Record<string, unknown>;
      if (!("blocked_ssids" in settings)) continue;

      const list = parseNetworkList(settings.blocked_ssids, `[sync.${row.source}].blocked_ssids`);
      for (const network of list) {
        if (!merged.some((existing) => existing.toLowerCase() === network.toLowerCase())) {
          merged.push(network);
        }
      }
      delete settings.blocked_ssids;
      if (list.length > 0) settings.skip_blocked_networks = true;

      db.prepare("UPDATE sync_sources SET settings = ?, updated_at = datetime('now') WHERE source = ?")
        .run(JSON.stringify(settings), row.source);
      migrated = true;
    }

    if (migrated) setBlockedNetworks(db, merged);
  })();
}

// Sync state CRUD operations

/**
 * Get sync state for a source
 * Returns parsed JSON or null if not found
 */
export function getSyncState<T>(db: Database, source: string): T | null {
  const row = db
    .prepare("SELECT state FROM sync_state WHERE source = ?")
    .get(source) as { state: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.state) as T;
  } catch {
    return null;
  }
}

/**
 * Set sync state for a source
 * Upserts the state as JSON
 */
export function setSyncState(db: Database, source: string, state: unknown): void {
  db.prepare(`
    INSERT INTO sync_state (source, state, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(source) DO UPDATE SET
      state = excluded.state,
      updated_at = datetime('now')
  `).run(source, JSON.stringify(state));
}

/**
 * Delete sync state for a source
 */
export function deleteSyncState(db: Database, source: string): void {
  db.prepare("DELETE FROM sync_state WHERE source = ?").run(source);
}

// ============================================================================
// Spotify Resources Cache
// ============================================================================

export interface SpotifyResource {
  uri: string;
  type: string;
  name: string;
  image_url: string | null;
  updated_at: string;
}

/**
 * Get a Spotify resource by URI
 */
export function getSpotifyResource(db: Database, uri: string): SpotifyResource | null {
  return db
    .prepare("SELECT * FROM spotify_resources WHERE uri = ?")
    .get(uri) as SpotifyResource | null;
}

/**
 * Set (upsert) a Spotify resource
 */
export function setSpotifyResource(
  db: Database,
  uri: string,
  type: string,
  name: string,
  imageUrl?: string | null
): void {
  db.prepare(`
    INSERT INTO spotify_resources (uri, type, name, image_url, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(uri) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      image_url = COALESCE(excluded.image_url, spotify_resources.image_url),
      updated_at = datetime('now')
  `).run(uri, type, name, imageUrl ?? null);
}

/**
 * Get all Spotify resources as a Map<uri, name>
 */
export function getAllSpotifyResources(db: Database): Map<string, string> {
  const rows = db
    .prepare("SELECT uri, name FROM spotify_resources")
    .all() as { uri: string; name: string }[];
  return new Map(rows.map((r) => [r.uri, r.name]));
}

/**
 * Cover-art URL for a single playlist (by bare ID), or null if none is cached.
 * Reads the `spotify:playlist:<id>` row populated by the spotify-playlists sync.
 */
export function getPlaylistImageUrl(db: Database, playlistId: string): string | null {
  const uri = `spotify:playlist:${playlistId}`;
  return getTrackImageUrls(db, [uri]).get(uri) ?? null;
}

/**
 * Look up image URLs for a list of track URIs
 * Returns a Map<uri, imageUrl> for tracks that have cached images
 */
export function getTrackImageUrls(db: Database, uris: string[]): Map<string, string> {
  if (uris.length === 0) return new Map();

  const placeholders = uris.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT uri, image_url FROM spotify_resources WHERE uri IN (${placeholders}) AND image_url IS NOT NULL`)
    .all(...uris) as { uri: string; image_url: string }[];
  return new Map(rows.map((r) => [r.uri, r.image_url]));
}

// ============================================================================
// Journal Sessions Cache
// ============================================================================

export interface JournalQuestion {
  question: string;
  category: string;
  group_ids?: string[];
}

export interface JournalSession {
  date: string;
  model: string;
  questions: JournalQuestion[];
  created_at: string;
}

export function getCachedJournalSession(
  db: Database,
  date: string,
  model: string,
): JournalSession | null {
  const row = db
    .prepare("SELECT * FROM journal_sessions WHERE date = ? AND model = ?")
    .get(date, model) as { date: string; model: string; questions: string; created_at: string } | null;
  if (!row) return null;
  return {
    ...row,
    questions: JSON.parse(row.questions),
  };
}

export function saveJournalSession(
  db: Database,
  date: string,
  model: string,
  questions: JournalQuestion[],
): void {
  db.prepare(`
    INSERT OR REPLACE INTO journal_sessions (date, model, questions)
    VALUES (?, ?, ?)
  `).run(date, model, JSON.stringify(questions));
}
