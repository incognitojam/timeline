import { Database } from "bun:sqlite";
import type { AttachmentStatus } from "../shared/attachments";
import { conversationEventEligibilityClause, conversationTypeClause } from "./conversation-types";
import { assertNoLocalDbMarker, getDbPathInfo, getTimelineDbPath } from "./paths";

/**
 * Valid platforms for qualified identifiers (platform:id format).
 * Used by parsers and migration scripts to create/validate identities.
 */
export const VALID_PLATFORMS = [
  "amp",
  "chatgpt",
  "claude",
  "claude-code",
  "codex",
  "conductor",
  "discord",
  "facebook",
  "github",
  "google-calendar",
  "google-chat",
  "instagram",
  "linkedin",
  "live", // From Skype parsing (live:username)
  "monzo",
  "opencode",
  "phone",
  "reddit",
  "skype",
  "steam",
  "spotify",
  "t3code",
  "youtube",
] as const;

export type Platform = (typeof VALID_PLATFORMS)[number];

/**
 * SQL expression that computes a normalized name from an identities row.
 * Used for the stored normalized_name column (via triggers) and backfill.
 * Must match the JS normalizeIdentityName() logic in identities.ts.
 */
export const NORMALIZE_NAME_EXPR = (prefix: string) => `
  TRIM(LOWER(REPLACE(REPLACE(REPLACE(
    CASE
      WHEN ${prefix}.display_name LIKE 'name:%' THEN substr(${prefix}.display_name, 6)
      WHEN ${prefix}.display_name IS NOT NULL AND LENGTH(TRIM(${prefix}.display_name)) > 0 THEN ${prefix}.display_name
      WHEN ${prefix}.username IS NOT NULL AND LENGTH(TRIM(${prefix}.username)) > 0 THEN ${prefix}.username
      WHEN ${prefix}.platform_id LIKE 'name:%' THEN substr(${prefix}.platform_id, 6)
      ELSE ${prefix}.platform_id
    END
  , '_', ' '), '.', ' '), '-', ' ')))
`;

const VALID_PLATFORMS_SET = new Set<string>(VALID_PLATFORMS);
const ISO_TIMESTAMP_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*";

/**
 * Check if an identifier is properly qualified (platform:id format with valid platform).
 * Returns true for "discord:123456", false for "Name :)" or "Title: Subtitle".
 */
export function isQualifiedIdentifier(value: string): boolean {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) return false;
  const platform = value.slice(0, colonIndex);
  return VALID_PLATFORMS_SET.has(platform);
}

/**
 * Check if a string is a valid platform.
 */
export function isValidPlatform(value: string): value is Platform {
  return VALID_PLATFORMS_SET.has(value);
}

/**
 * Assert that a string is a valid platform, throwing if not.
 */
export function assertPlatform(value: string): asserts value is Platform {
  if (!VALID_PLATFORMS_SET.has(value)) {
    throw new Error(`Invalid platform: ${value}`);
  }
}

const DB_PATH = getTimelineDbPath();

// Validate DB path at module load time - catches misconfigured parsers early
const dbPathInfo = getDbPathInfo(DB_PATH);
assertNoLocalDbMarker(dbPathInfo, dbPathInfo.resolvedDbPath, "database");

/**
 * Settings every writable connection needs, as opposed to the schema itself.
 * journal_mode = WAL persists in the database file once set; the others are
 * per connection.
 *
 * recursive_triggers matters for correctness, not just performance: REPLACE
 * resolves uniqueness conflicts through an implicit DELETE + INSERT, and SQLite
 * only fires DELETE triggers for that path when it is on — which derived tables
 * and FTS need to balance the removed row. Every connection that writes must set
 * it, so both getDb() and initDb() (whose callers open their own connections) do.
 */
function applyConnectionPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA recursive_triggers = ON");
}

export function getDb(): Database {
  const db = new Database(DB_PATH);
  applyConnectionPragmas(db);
  return db;
}

/**
 * Get the SQL definition of a trigger from sqlite_master.
 * Returns null if the trigger doesn't exist.
 */
function getTriggerSql(db: Database, name: string): string | null {
  const result = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
    .get(name) as { sql: string } | null;
  return result?.sql || null;
}

/**
 * Normalize SQL for comparison by collapsing whitespace.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Check if a trigger exists with the expected SQL definition.
 */
function triggerMatches(db: Database, name: string, expectedSql: string): boolean {
  const existing = getTriggerSql(db, name);
  if (!existing) return false;
  return normalizeSql(existing) === normalizeSql(expectedSql);
}

/**
 * Ensure a trigger exists with the expected definition.
 * Only drops and recreates if the trigger is missing or has a different definition.
 */
function ensureTrigger(db: Database, name: string, createSql: string): void {
  if (!triggerMatches(db, name, createSql)) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec(createSql);
  }
}

function getIndexSql(db: Database, name: string): string | null {
  const result = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
    .get(name) as { sql: string } | null;
  return result?.sql || null;
}

function indexMatches(db: Database, name: string, expectedSql: string): boolean {
  const existing = getIndexSql(db, name);
  if (!existing) return false;
  return normalizeSql(existing) === normalizeSql(expectedSql);
}

function ensureIndex(db: Database, name: string, createSql: string): void {
  if (!indexMatches(db, name, createSql)) {
    db.exec(`DROP INDEX IF EXISTS ${name}`);
    db.exec(createSql);
  }
}

export function initDb(db: Database) {
  // Callers that opened their own connection (tests, scripts) get the same
  // connection setup as getDb() gives.
  applyConnectionPragmas(db);

  // Core events table - unified timeline
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Source tracking
      source TEXT NOT NULL,           -- 'spotify', 'discord', 'google-location', etc.
      source_id TEXT,                 -- Original ID from source (spotify track uri, message id, etc.)
      source_account TEXT,            -- Which account this came from (for multiple accounts per source)

      -- Event classification
      type TEXT NOT NULL,             -- 'listen', 'message', 'location', 'photo', etc.

      -- Temporal (timestamp nullable for events without dates, e.g., Reddit votes)
      timestamp TEXT,                 -- ISO 8601, null for dateless events
      end_timestamp TEXT,             -- For durations (listening, location dwell time)
      duration_ms INTEGER,            -- Precomputed duration in milliseconds

      -- Content (searchable)
      title TEXT,                     -- Track name, message snippet, photo caption, etc.
      content TEXT,                   -- Full content for search (artist + album, full message, etc.)

      -- Location (optional)
      latitude REAL,
      longitude REAL,
      location_name TEXT,

      -- Entities (JSON arrays for flexible linking)
      people JSON,                    -- ["person_id_1", "person_id_2"]
      tags JSON,                      -- ["work", "travel", "music"]

      -- Raw data preservation
      raw_data JSON NOT NULL,         -- Original import data, never modified

      -- Metadata
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      import_batch TEXT,              -- Group imports together for easy re-import

      -- Unique constraint to prevent duplicates
      UNIQUE(source, source_id, source_account)
    )
  `);

  // Migration: add conversation_id column. Stable conversation identity from
  // raw_data (e.g. Discord channel snowflake) — survives channel/group renames
  // that otherwise change `title`.
  try { db.exec(`ALTER TABLE events ADD COLUMN conversation_id TEXT`); } catch { /* already exists */ }

  // When a source confirms that an event has been deleted, retain the archived
  // event and record when Timeline observed the deletion. This is deliberately
  // not named `deleted_at`: source APIs rarely expose the actual deletion time.
  try { db.exec(`ALTER TABLE events ADD COLUMN source_deleted_observed_at TEXT`); } catch { /* already exists */ }

  // Superseded source snapshots. The current snapshot remains in events; rows
  // are created lazily only when a later observation changes an event.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      observed_at TEXT NOT NULL,
      source_edited_at TEXT,
      raw_data JSON NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_versions_event_observed ON event_versions(event_id, observed_at)`);
  ensureTrigger(
    db,
    "event_versions_event_ad",
    `CREATE TRIGGER event_versions_event_ad AFTER DELETE ON events BEGIN
      DELETE FROM event_versions WHERE event_id = OLD.id;
    END`,
  );

  // Per-renderer sweep progress. A row at version N means every event for the
  // source through last_event_id has been considered by renderer version N.
  db.exec(`
    CREATE TABLE IF NOT EXISTS render_sweep_state (
      source TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      last_event_id INTEGER NOT NULL,
      updated_at TEXT
    )
  `);

  // Indexes for common queries
  // Covers timestamp-range queries that also read source or location without
  // table lookups. Its timestamp prefix also serves timestamp-only lookups.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_events_timestamp_source_location ON events(timestamp, source, location_name)`
  );
  db.exec(`DROP INDEX IF EXISTS idx_events_timestamp`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_source_type ON events(source, type)`);
  // Covers date-filtered per-source aggregations without table lookups; also
  // serves source-only lookups, so the prefix-redundant idx_events_source is
  // dropped (created after, so an interrupted init never leaves neither).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_source_timestamp ON events(source, timestamp)`);
  db.exec(`DROP INDEX IF EXISTS idx_events_source`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_source_id ON events(source, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_location ON events(latitude, longitude) WHERE latitude IS NOT NULL`);
  ensureIndex(
    db,
    "idx_events_conversations",
    `CREATE INDEX idx_events_conversations ON events(source, source_account, title, timestamp) WHERE ${conversationEventEligibilityClause()}`,
  );
  ensureIndex(
    db,
    "idx_events_conversation_id",
    `CREATE INDEX idx_events_conversation_id ON events(source, source_account, conversation_id, timestamp) WHERE conversation_id IS NOT NULL AND ${conversationTypeClause()}`,
  );

  ensureEventDaySources(db);

  migrateConversationSummariesToConversationIds(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      source TEXT NOT NULL,
      source_account TEXT,
      source_account_key TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      first_message TEXT,
      last_message TEXT,
      latest_title_timestamp TEXT,
      latest_title_event_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source, source_account_key, conversation_id)
    )
  `);
  ensureIndex(
    db,
    "idx_conversation_summaries_list",
    `CREATE INDEX idx_conversation_summaries_list ON conversation_summaries(last_message DESC, source, source_account_key, conversation_id)`,
  );
  ensureIndex(
    db,
    "idx_conversation_summaries_source_list",
    `CREATE INDEX idx_conversation_summaries_source_list ON conversation_summaries(source, last_message DESC)`,
  );
  ensureIndex(
    db,
    "idx_conversation_summaries_title",
    `CREATE INDEX idx_conversation_summaries_title ON conversation_summaries(title)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summary_titles (
      source TEXT NOT NULL,
      source_account_key TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      first_seen TEXT,
      last_seen TEXT,
      message_count INTEGER NOT NULL,
      PRIMARY KEY (source, source_account_key, conversation_id, title),
      FOREIGN KEY (source, source_account_key, conversation_id)
        REFERENCES conversation_summaries(source, source_account_key, conversation_id)
        ON DELETE CASCADE
    )
  `);
  ensureIndex(
    db,
    "idx_conversation_summary_titles_title",
    `CREATE INDEX idx_conversation_summary_titles_title ON conversation_summary_titles(title)`,
  );

  ensureConversationSummaryTriggers(db);
  ensureConversationSummariesBackfilled(db);

  // FTS5 for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      title,
      content,
      location_name,
      content=events,
      content_rowid=id
    )
  `);

  // FTS triggers - only recreate if missing or different from expected
  ensureTrigger(
    db,
    "events_ai",
    `CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, title, content, location_name)
      VALUES (NEW.id, NEW.title, NEW.content, NEW.location_name);
    END`
  );

  ensureTrigger(
    db,
    "events_ad",
    `CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, content, location_name)
      VALUES ('delete', OLD.id, OLD.title, OLD.content, OLD.location_name);
    END`
  );

  ensureTrigger(
    db,
    "events_au",
    `CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, content, location_name)
      VALUES ('delete', OLD.id, OLD.title, OLD.content, OLD.location_name);
      INSERT INTO events_fts(rowid, title, content, location_name)
      VALUES (NEW.id, NEW.title, NEW.content, NEW.location_name);
    END`
  );

  // Guard: timestamp and end_timestamp, when present, must be full ISO
  // datetimes (date + 'T' + time). A bare 'YYYY-MM-DD' sorts before the day
  // view's lower bound ('YYYY-MM-DDT00:00:00'), so a bare `timestamp` is
  // silently excluded from /timeline?date=... while still appearing in search
  // (the bug that bit the Amex and LinkedIn parsers), and a bare `end_timestamp`
  // breaks the lexicographic comparisons that assume the column is ISO (e.g.
  // wakatime's `excluded.end_timestamp > events.end_timestamp` tie-break in
  // wakatime-api.ts). Fail fast at the write boundary instead. INSERT-only on
  // purpose: the guard polices new writes, so any legacy bare-date row that
  // predates it stays updatable rather than being locked out of repair.
  ensureTrigger(
    db,
    "events_timestamp_iso",
    `CREATE TRIGGER events_timestamp_iso BEFORE INSERT ON events
      WHEN (NEW.timestamp IS NOT NULL AND NEW.timestamp NOT GLOB '${ISO_TIMESTAMP_GLOB}')
        OR (NEW.end_timestamp IS NOT NULL AND NEW.end_timestamp NOT GLOB '${ISO_TIMESTAMP_GLOB}')
    BEGIN
      SELECT CASE
        WHEN NEW.timestamp IS NOT NULL AND NEW.timestamp NOT GLOB '${ISO_TIMESTAMP_GLOB}'
          THEN RAISE(ABORT, 'events.timestamp must be a full ISO datetime (e.g. 2026-05-04T00:00:00Z), not a bare date — bare dates are silently excluded from the day-view range query')
        ELSE RAISE(ABORT, 'events.end_timestamp must be a full ISO datetime (e.g. 2026-05-04T00:00:00Z), not a bare date — keep it ISO so lexicographic time comparisons stay correct')
      END;
    END`
  );

  // Guard: conversation events (messages/SMS/MMS/calls that carry a title) must
  // have a non-empty source_account. A NULL account defeats the
  // UNIQUE(source, source_id, source_account) dedup — SQLite treats NULLs as
  // distinct, so a parser that dropped the account would re-insert the same
  // message on every run without tripping the constraint — and an empty account
  // splits one thread across separate conversation_summaries rows. Fail fast at
  // the write boundary. INSERT-only, like events_timestamp_iso above: no caller
  // updates source_account/type on existing rows, so an UPDATE guard would only
  // add complexity to forbid a mutation nothing performs.
  ensureTrigger(
    db,
    "events_conversation_source_account_bi",
    `CREATE TRIGGER events_conversation_source_account_bi BEFORE INSERT ON events
      WHEN ${conversationEventEligibilityClause("NEW.")}
        AND (NEW.source_account IS NULL OR TRIM(NEW.source_account) = '')
    BEGIN
      SELECT RAISE(ABORT, 'conversation events require a non-empty source_account');
    END`
  );

  // Guard: conversation events must carry a conversation_id, so no parser can
  // silently regress to title-keyed grouping (which collapses same-title
  // threads). Every conversation source derives the id at insert via
  // extractConversationId() on the object it persists as raw_data. INSERT-only
  // like the guards above; existing NULL rows are frozen by the summaries
  // migration or stay readable through raw title fallback on stale dev DBs.
  ensureTrigger(
    db,
    "events_conversation_id_bi",
    `CREATE TRIGGER events_conversation_id_bi BEFORE INSERT ON events
      WHEN ${conversationEventEligibilityClause("NEW.")}
        AND NEW.conversation_id IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'conversation events require a conversation_id — derive it with extractConversationId() from the persisted raw_data (src/db/conversation-id.ts)');
    END`
  );

  // Contacts table - for linking people across platforms
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      notes TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add date_of_birth to contacts
  try { db.exec(`ALTER TABLE contacts ADD COLUMN date_of_birth TEXT`); } catch { /* already exists */ }

  // Migration: add is_self to contacts (marks the contact representing the user)
  try { db.exec(`ALTER TABLE contacts ADD COLUMN is_self INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_is_self ON contacts(is_self) WHERE is_self = 1`);

  // Contact memories - AI-stored facts about contacts
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contact_memories_contact ON contact_memories(contact_id)`);

  // Contact aliases - links platform-specific names/usernames to contacts
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(alias, source)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_contact_aliases_alias ON contact_aliases(alias)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contact_aliases_contact ON contact_aliases(contact_id)`);

  // Cache table for precomputed stats (contact event counts, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value JSON NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Places table - lookup for Google place IDs to names
  db.exec(`
    CREATE TABLE IF NOT EXISTS places (
      place_id TEXT PRIMARY KEY,
      name TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      source TEXT NOT NULL DEFAULT 'extracted',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Skipped aliases - permanently hide suggestions without linking to a contact
  // DEPRECATED: Use identities.skipped instead. Kept for migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS skipped_aliases (
      alias TEXT NOT NULL,
      source TEXT NOT NULL,
      skipped_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (alias, source)
    )
  `);

  // Contact match suggestions - fuzzy matching results for review
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_match_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias_a TEXT NOT NULL,
      source_a TEXT,
      alias_b TEXT NOT NULL,
      source_b TEXT,
      score REAL NOT NULL,
      match_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      UNIQUE(alias_a, source_a, alias_b, source_b)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_match_suggestions_status ON contact_match_suggestions(status)`);

  // Platform identities - unified identity tracking across platforms
  // Replaces contact_aliases and skipped_aliases functionality
  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,           -- 'discord', 'live', 'phone', etc.
      platform_id TEXT NOT NULL,        -- Platform-specific ID
      display_name TEXT,                -- Most recent display name (from imports)
      username TEXT,                    -- Username if different from display_name
      contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      skipped INTEGER NOT NULL DEFAULT 0,  -- 1 = user dismissed from suggestions
      avatar_url TEXT,                          -- Profile photo/avatar URL
      event_count INTEGER NOT NULL DEFAULT 0,  -- Denormalized count from event_people
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, platform_id)
    )
  `);
  // Migration: add avatar_url column if missing (older DBs don't have it)
  try {
    db.exec(`ALTER TABLE identities ADD COLUMN avatar_url TEXT`);
  } catch {
    // Column already exists
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_identities_lookup ON identities(platform, platform_id)`);
  // Platform-agnostic lookup by platform_id alone (e.g. resolving a bare snowflake
  // ID without knowing which platform it belongs to). The composite index above
  // can't service `WHERE platform_id = ?` because platform_id is the trailing column.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_identities_platform_id ON identities(platform_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_identities_contact ON identities(contact_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_identities_display_name ON identities(display_name)`);
  // Partial index for fast unlinked identity queries sorted by event count
  db.exec(`CREATE INDEX IF NOT EXISTS idx_identities_unlinked ON identities(event_count DESC) WHERE contact_id IS NULL AND skipped = 0`);
  // Migration: add avatar_url column if missing
  try {
    db.exec(`ALTER TABLE identities ADD COLUMN avatar_url TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add normalized_name column for fast name-matching queries
  try {
    db.exec(`ALTER TABLE identities ADD COLUMN normalized_name TEXT`);
  } catch {
    // Column already exists
  }
  // Backfill normalized_name for existing rows (idempotent: only updates NULLs)
  db.exec(`
    UPDATE identities SET normalized_name = ${NORMALIZE_NAME_EXPR('identities')}
    WHERE normalized_name IS NULL
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_identities_normalized_name ON identities(normalized_name) WHERE normalized_name IS NOT NULL`);

  // Event people index - denormalized from events.people JSON for fast lookups
  // Includes timestamp for efficient sorting when querying by person
  // is_sender tracks whether this person is people[0] (the sender/originator)
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_people (
      event_id INTEGER NOT NULL,
      person TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp TEXT,
      is_sender INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (event_id, person)
    )
  `);
  // Migration: add timestamp column if missing (older DBs don't have it)
  try {
    db.exec(`ALTER TABLE event_people ADD COLUMN timestamp TEXT`);
  } catch {
    // Column already exists
  }
  // Migration: add is_sender column if missing (older DBs don't have it)
  try {
    db.exec(`ALTER TABLE event_people ADD COLUMN is_sender INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
  // Index for fast person lookup with timestamp sorting
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_people_person ON event_people(person, source)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_people_person_ts ON event_people(person, source, timestamp DESC)`);
  // Index for source-agnostic person lookup (when alias.source is null)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_people_person_only_ts ON event_people(person, timestamp DESC)`);
  // Index for sender-filtered queries (contact's direct events vs just mentioned)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_people_sender_ts ON event_people(person, is_sender, timestamp DESC)`);

  // event_people triggers - drop and recreate to ensure latest definitions
  // (IF NOT EXISTS would skip updates to existing triggers)
  ensureEventPeopleTriggers(db);

  // Attachments table - for media files associated with events
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_id TEXT,                   -- Original ID from source (e.g., filename in ZIP)
      content_hash TEXT,                -- SHA-256 for deduplication
      filename TEXT,
      mime_type TEXT,
      file_size INTEGER,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      storage_path TEXT,                -- Relative to media root
      original_uri TEXT,                -- Original path (e.g., path in ZIP file)
      status TEXT NOT NULL DEFAULT 'pending',  -- pending/stored/failed/unrecoverable
      thumbhash TEXT,                         -- Base64 ThumbHash for LQIP placeholders
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(event_id, source_id)
    )
  `);

  // Migration: add thumbhash column if missing (older DBs don't have it)
  try {
    db.exec(`ALTER TABLE attachments ADD COLUMN thumbhash TEXT`);
  } catch {
    // Column already exists
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_event ON attachments(event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_hash ON attachments(content_hash) WHERE content_hash IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_status ON attachments(status)`);
  // Maps a served storage_path back to its content_hash for restoring a missing
  // local file from the remote backend (read-through cache).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_storage_path ON attachments(storage_path) WHERE storage_path IS NOT NULL`);
  // Partial index for efficient thumbhash processing queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_needs_thumbhash ON attachments(id) WHERE status = 'stored' AND storage_path IS NOT NULL AND mime_type LIKE 'image/%' AND thumbhash IS NULL`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attachment_descriptions (
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER,
      PRIMARY KEY (content_hash, model)
    )
  `);

  // Migration: record how long description generation took on older databases.
  try {
    db.exec(`ALTER TABLE attachment_descriptions ADD COLUMN duration_ms INTEGER`);
  } catch {
    // Column already exists
  }

  // Discord custom emoji - globally shared resource keyed by Discord snowflake.
  // Distinct from `attachments` because emoji are reused across thousands of
  // messages/reactions and survive message deletion.
  // `animated` is tri-state: NULL=unknown (probe gif-first), 0=known static,
  // 1=known animated. Distinguishing unknown from known-static avoids wasting
  // a CDN round-trip on every static emoji during backfill.
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_emojis (
      emoji_id      TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      animated      INTEGER,
      ext           TEXT,
      content_hash  TEXT,
      storage_path  TEXT,
      file_size     INTEGER,
      status        TEXT NOT NULL DEFAULT 'pending',
      first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT NOT NULL DEFAULT (datetime('now')),
      fetched_at    TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_discord_emojis_pending ON discord_emojis(emoji_id) WHERE status = 'pending'`);

  // Discord guild emoji inventory - current and previously seen custom emoji
  // for each guild. This is separate from `discord_emojis`: that table caches
  // image bytes globally by emoji ID, while this table records guild ownership
  // and uploader metadata from the guild emoji listing endpoint.
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_guild_emojis (
      guild_id             TEXT NOT NULL,
      emoji_id             TEXT NOT NULL,
      name                 TEXT NOT NULL,
      animated             INTEGER NOT NULL DEFAULT 0,
      available            INTEGER,
      managed              INTEGER,
      require_colons       INTEGER,
      uploader_id          TEXT,
      uploader_username    TEXT,
      uploader_display_name TEXT,
      uploader_avatar_url  TEXT,
      raw_data             JSON NOT NULL,
      first_seen           TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen            TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at           TEXT,
      PRIMARY KEY (guild_id, emoji_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_discord_guild_emojis_guild ON discord_guild_emojis(guild_id) WHERE deleted_at IS NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_discord_guild_emojis_uploader ON discord_guild_emojis(guild_id, uploader_id) WHERE deleted_at IS NULL`);

  // Discord guild metadata - one row per guild, keyed by snowflake. Captured
  // from fetchGuild during sync so the UI can show the server's real icon
  // instead of an acronym placeholder. `icon` is the icon hash (null when the
  // guild has no icon); the image itself is served from Discord's CDN.
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_guilds (
      guild_id   TEXT PRIMARY KEY,
      icon       TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Discord reaction observations - snapshots of reaction counts at each
  // re-fetch tier ('initial' plus the TIERS in src/platforms/discord/tier-rescan.ts).
  // Used to measure reaction latency and tune the tier intervals. Only
  // populated when total_count > 0. Rows from retired tiers (e.g. '30d') are
  // kept as historical data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_reaction_observations (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      tier TEXT NOT NULL,                  -- 'initial' | tier name from TIERS
      observed_at TEXT NOT NULL,           -- ISO 8601
      age_ms INTEGER NOT NULL,             -- observed_at - message_timestamp
      total_count INTEGER NOT NULL,
      emoji_counts JSON NOT NULL,          -- {"👍": 3, "❤️": 1}
      PRIMARY KEY (event_id, tier)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_discord_reaction_obs_tier ON discord_reaction_observations(tier, observed_at)`);

  // Spotify playlist follower observations - time series of a playlist's public
  // follower count (the "saves"/likes number shown in the Spotify UI). Polled by
  // the spotify-playlists sync source. This is a gauge sampled over time, not a
  // discrete timeline event, so it lives in its own table (like
  // discord_reaction_observations) rather than polluting `events`/FTS.
  // One row per playlist per day; intra-day re-syncs upsert the latest reading.
  db.exec(`
    CREATE TABLE IF NOT EXISTS spotify_playlist_observations (
      playlist_id    TEXT NOT NULL,               -- Spotify playlist ID
      observed_date  TEXT NOT NULL,               -- YYYY-MM-DD (one row per playlist per day)
      observed_at    TEXT NOT NULL,               -- ISO 8601 timestamp of the kept reading
      follower_count INTEGER NOT NULL,            -- followers.total (= public "saves"/likes count)
      name           TEXT,                        -- playlist name at observation time
      origin         TEXT NOT NULL DEFAULT 'api', -- 'api' (synced) | 'seed' (manual backfill)
      raw_data       JSON,                        -- API response or seed row
      PRIMARY KEY (playlist_id, observed_date)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_playlist_obs_date ON spotify_playlist_observations(observed_date)`);

  // Per-playlist metadata that isn't a time series. `created_at` is a
  // best-effort creation date: Spotify's API exposes no creation field, so the
  // spotify-playlists sync derives it from the earliest track `added_at`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS spotify_playlist_meta (
      playlist_id  TEXT PRIMARY KEY,  -- Spotify playlist ID
      created_at   TEXT,              -- ISO 8601: earliest track added_at; NULL = unknown
      checked_at   TEXT NOT NULL      -- ISO 8601: when created_at was last computed
    )
  `);
}

function ensureEventDaySources(db: Database): void {
  db.transaction(() => {
    // Four-month calendar windows can span hundreds of thousands of events on a
    // large database. Keep the endpoint's small day/source result current at the
    // write boundary so each request only scans the requested summary rows.
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_day_sources (
        range_day TEXT NOT NULL,
        day TEXT NOT NULL,
        source TEXT NOT NULL,
        event_count INTEGER NOT NULL CHECK (event_count > 0),
        location_count INTEGER NOT NULL CHECK (
          location_count >= 0 AND location_count <= event_count
        ),
        PRIMARY KEY (range_day, day, source)
      ) WITHOUT ROWID
    `);
    ensureEventDaySourceTriggers(db);
    ensureEventDaySourcesBackfilled(db);
  }).immediate();
}

function ensureEventDaySourcesBackfilled(db: Database): void {
  const existing = db.prepare("SELECT 1 FROM event_day_sources LIMIT 1").get();
  if (existing) return;

  const datedEvent = db
    .prepare(
      `SELECT 1 FROM events
       WHERE timestamp GLOB '${ISO_TIMESTAMP_GLOB}'
         AND date(timestamp) IS NOT NULL
       LIMIT 1`,
    )
    .get();
  if (!datedEvent) return;

  db.exec(`
    INSERT INTO event_day_sources (
      range_day, day, source, event_count, location_count
    )
    SELECT
      substr(timestamp, 1, 10),
      date(timestamp),
      source,
      COUNT(*),
      COUNT(location_name)
    FROM events
    WHERE timestamp GLOB '${ISO_TIMESTAMP_GLOB}'
      AND date(timestamp) IS NOT NULL
    GROUP BY substr(timestamp, 1, 10), date(timestamp), source
  `);
}

function ensureEventDaySourceTriggers(db: Database): void {
  ensureTrigger(
    db,
    "event_day_sources_ai",
    `CREATE TRIGGER event_day_sources_ai AFTER INSERT ON events
      WHEN NEW.timestamp GLOB '${ISO_TIMESTAMP_GLOB}'
        AND date(NEW.timestamp) IS NOT NULL
    BEGIN
      INSERT INTO event_day_sources (
        range_day, day, source, event_count, location_count
      )
      VALUES (
        substr(NEW.timestamp, 1, 10),
        date(NEW.timestamp),
        NEW.source,
        1,
        CASE WHEN NEW.location_name IS NOT NULL THEN 1 ELSE 0 END
      )
      ON CONFLICT(range_day, day, source) DO UPDATE SET
        event_count = event_day_sources.event_count + 1,
        location_count = event_day_sources.location_count + excluded.location_count;
    END`,
  );

  ensureTrigger(
    db,
    "event_day_sources_ad",
    `CREATE TRIGGER event_day_sources_ad AFTER DELETE ON events
      WHEN OLD.timestamp GLOB '${ISO_TIMESTAMP_GLOB}'
        AND date(OLD.timestamp) IS NOT NULL
    BEGIN
      DELETE FROM event_day_sources
      WHERE range_day = substr(OLD.timestamp, 1, 10)
        AND day = date(OLD.timestamp)
        AND source = OLD.source
        AND event_count = 1;
      UPDATE event_day_sources
      SET
        event_count = event_count - 1,
        location_count = location_count
          - CASE WHEN OLD.location_name IS NOT NULL THEN 1 ELSE 0 END
      WHERE range_day = substr(OLD.timestamp, 1, 10)
        AND day = date(OLD.timestamp)
        AND source = OLD.source;
    END`,
  );

  ensureTrigger(
    db,
    "event_day_sources_au",
    `CREATE TRIGGER event_day_sources_au
      AFTER UPDATE OF timestamp, source, location_name ON events
      WHEN OLD.timestamp IS NOT NEW.timestamp
        OR OLD.source IS NOT NEW.source
        OR OLD.location_name IS NOT NEW.location_name
    BEGIN
      DELETE FROM event_day_sources
      WHERE range_day = substr(OLD.timestamp, 1, 10)
        AND day = date(OLD.timestamp)
        AND source = OLD.source
        AND event_count = 1;
      UPDATE event_day_sources
      SET
        event_count = event_count - 1,
        location_count = location_count
          - CASE WHEN OLD.location_name IS NOT NULL THEN 1 ELSE 0 END
      WHERE range_day = substr(OLD.timestamp, 1, 10)
        AND day = date(OLD.timestamp)
        AND source = OLD.source;

      INSERT INTO event_day_sources (
        range_day, day, source, event_count, location_count
      )
      SELECT
        substr(NEW.timestamp, 1, 10),
        date(NEW.timestamp),
        NEW.source,
        1,
        CASE WHEN NEW.location_name IS NOT NULL THEN 1 ELSE 0 END
      WHERE NEW.timestamp GLOB '${ISO_TIMESTAMP_GLOB}'
        AND date(NEW.timestamp) IS NOT NULL
      ON CONFLICT(range_day, day, source) DO UPDATE SET
        event_count = event_day_sources.event_count + 1,
        location_count = event_day_sources.location_count + excluded.location_count;
    END`,
  );
}

const CONVERSATION_EVENT_CONDITION = conversationEventEligibilityClause();
const SOURCE_ACCOUNT_NULL_KEY = "null:";
const SOURCE_ACCOUNT_VALUE_PREFIX = "value:";
const SOURCE_ACCOUNT_KEY_SQL = `CASE WHEN source_account IS NULL THEN '${SOURCE_ACCOUNT_NULL_KEY}' ELSE '${SOURCE_ACCOUNT_VALUE_PREFIX}' || source_account END`;

export function conversationSourceAccountKey(sourceAccount: string | null): string {
  return sourceAccount === null ? SOURCE_ACCOUNT_NULL_KEY : `${SOURCE_ACCOUNT_VALUE_PREFIX}${sourceAccount}`;
}

function sourceAccountKeySql(alias: string): string {
  return `CASE WHEN ${alias}.source_account IS NULL THEN '${SOURCE_ACCOUNT_NULL_KEY}' ELSE '${SOURCE_ACCOUNT_VALUE_PREFIX}' || ${alias}.source_account END`;
}

function migrateConversationSummariesToConversationIds(db: Database): void {
  const oldSchema = db
    .prepare("SELECT 1 FROM pragma_table_info('conversation_summaries') WHERE name = 'key_kind'")
    .get();
  if (!oldSchema) return;

  db.transaction(() => {
    db.exec(`DROP TRIGGER IF EXISTS conversation_summaries_ai`);
    db.exec(`DROP TRIGGER IF EXISTS conversation_summaries_ad`);
    db.exec(`DROP TRIGGER IF EXISTS conversation_summaries_au`);
    db.exec(`
      UPDATE events
      SET conversation_id = 'legacy:' || title
      WHERE conversation_id IS NULL
        AND ${CONVERSATION_EVENT_CONDITION}
    `);
    db.exec(`DROP TABLE IF EXISTS conversation_summary_titles`);
    db.exec(`DROP TABLE IF EXISTS conversation_summaries`);
  })();
}

function rebuildConversationSummaries(db: Database): void {
  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS temp.conversation_summary_eligible`);
    db.exec(`
      CREATE TEMP TABLE conversation_summary_eligible AS
      SELECT
        id,
        source,
        source_account,
        ${SOURCE_ACCOUNT_KEY_SQL} AS source_account_key,
        conversation_id,
        title,
        timestamp
      FROM events
      WHERE ${CONVERSATION_EVENT_CONDITION}
        AND conversation_id IS NOT NULL
    `);
    db.exec(`
      CREATE INDEX temp.idx_conversation_summary_eligible_group_latest
      ON conversation_summary_eligible(source, source_account_key, conversation_id, timestamp DESC, id DESC)
    `);
    db.exec(`
      CREATE INDEX temp.idx_conversation_summary_eligible_group_title
      ON conversation_summary_eligible(source, source_account_key, conversation_id, title)
    `);

    db.exec(`DELETE FROM conversation_summary_titles`);
    db.exec(`DELETE FROM conversation_summaries`);
    db.exec(`
      INSERT INTO conversation_summaries (
        source, source_account, source_account_key, conversation_id,
        title, message_count, first_message, last_message,
        latest_title_timestamp, latest_title_event_id, updated_at
      )
      WITH grouped AS (
        SELECT
          source,
          source_account,
          ${SOURCE_ACCOUNT_KEY_SQL} AS source_account_key,
          conversation_id,
          COUNT(*) AS message_count,
          MIN(timestamp) AS first_message,
          MAX(timestamp) AS last_message
        FROM conversation_summary_eligible
        GROUP BY source, source_account, source_account_key, conversation_id
      ),
      latest AS (
        SELECT id, source, source_account_key, conversation_id, title, timestamp
        FROM (
          SELECT
            id,
            source,
            source_account_key,
            conversation_id,
            title,
            timestamp,
            row_number() OVER (
              PARTITION BY source, source_account_key, conversation_id
              ORDER BY timestamp DESC, id DESC
            ) AS rank
          FROM conversation_summary_eligible
        )
        WHERE rank = 1
      )
      SELECT
        g.source, g.source_account, g.source_account_key, g.conversation_id,
        latest.title,
        g.message_count,
        g.first_message,
        g.last_message,
        latest.timestamp,
        latest.id,
        datetime('now')
      FROM grouped g
      JOIN latest
        ON latest.source = g.source
       AND latest.source_account_key = g.source_account_key
       AND latest.conversation_id = g.conversation_id
    `);
    db.exec(`
      INSERT INTO conversation_summary_titles (
        source, source_account_key, conversation_id, title,
        first_seen, last_seen, message_count
      )
      SELECT
        source,
        ${SOURCE_ACCOUNT_KEY_SQL} AS source_account_key,
        conversation_id,
        title,
        MIN(timestamp),
        MAX(timestamp),
        COUNT(*)
      FROM conversation_summary_eligible
      GROUP BY source, source_account_key, conversation_id, title
    `);
    db.exec(`DROP TABLE temp.conversation_summary_eligible`);
  })();
}

function ensureConversationSummariesBackfilled(db: Database): void {
  const summary = db.prepare("SELECT COUNT(*) AS count FROM conversation_summaries").get() as { count: number };
  const titles = db.prepare("SELECT COUNT(*) AS count FROM conversation_summary_titles").get() as { count: number };
  if (summary.count > 0 && titles.count > 0) return;

  const eligible = db.prepare(`SELECT 1 FROM events WHERE ${CONVERSATION_EVENT_CONDITION} AND conversation_id IS NOT NULL LIMIT 1`).get();
  if (!eligible) return;

  rebuildConversationSummaries(db);
}

function ensureConversationSummaryTriggers(db: Database): void {
  const eventCondition = `${CONVERSATION_EVENT_CONDITION.replace(/\btype\b/g, "e.type").replace(/\btitle\b/g, "e.title")} AND e.conversation_id IS NOT NULL`;
  const latestEventCondition = `${CONVERSATION_EVENT_CONDITION.replace(/\btype\b/g, "e2.type").replace(/\btitle\b/g, "e2.title")} AND e2.conversation_id IS NOT NULL`;
  const insertFor = (ref: "NEW") => `
    INSERT INTO conversation_summaries (
      source, source_account, source_account_key, conversation_id,
      title, message_count, first_message, last_message,
      latest_title_timestamp, latest_title_event_id, updated_at
    ) VALUES (
      ${ref}.source,
      ${ref}.source_account,
      ${sourceAccountKeySql(ref)},
      ${ref}.conversation_id,
      ${ref}.title,
      1,
      ${ref}.timestamp,
      ${ref}.timestamp,
      ${ref}.timestamp,
      ${ref}.id,
      datetime('now')
    ) ON CONFLICT(source, source_account_key, conversation_id) DO UPDATE SET
      title = CASE
        WHEN conversation_summaries.latest_title_timestamp IS NULL THEN excluded.title
        WHEN excluded.latest_title_timestamp IS NULL THEN conversation_summaries.title
        WHEN excluded.latest_title_timestamp > conversation_summaries.latest_title_timestamp THEN excluded.title
        WHEN excluded.latest_title_timestamp = conversation_summaries.latest_title_timestamp
          AND excluded.latest_title_event_id > conversation_summaries.latest_title_event_id THEN excluded.title
        ELSE conversation_summaries.title
      END,
      message_count = conversation_summaries.message_count + 1,
      first_message = CASE
        WHEN conversation_summaries.first_message IS NULL THEN excluded.first_message
        WHEN excluded.first_message IS NULL THEN conversation_summaries.first_message
        WHEN excluded.first_message < conversation_summaries.first_message THEN excluded.first_message
        ELSE conversation_summaries.first_message
      END,
      last_message = CASE
        WHEN conversation_summaries.last_message IS NULL THEN excluded.last_message
        WHEN excluded.last_message IS NULL THEN conversation_summaries.last_message
        WHEN excluded.last_message > conversation_summaries.last_message THEN excluded.last_message
        ELSE conversation_summaries.last_message
      END,
      latest_title_timestamp = CASE
        WHEN conversation_summaries.latest_title_timestamp IS NULL THEN excluded.latest_title_timestamp
        WHEN excluded.latest_title_timestamp IS NULL THEN conversation_summaries.latest_title_timestamp
        WHEN excluded.latest_title_timestamp > conversation_summaries.latest_title_timestamp THEN excluded.latest_title_timestamp
        WHEN excluded.latest_title_timestamp = conversation_summaries.latest_title_timestamp
          AND excluded.latest_title_event_id > conversation_summaries.latest_title_event_id THEN excluded.latest_title_timestamp
        ELSE conversation_summaries.latest_title_timestamp
      END,
      latest_title_event_id = CASE
        WHEN conversation_summaries.latest_title_timestamp IS NULL THEN excluded.latest_title_event_id
        WHEN excluded.latest_title_timestamp IS NULL THEN conversation_summaries.latest_title_event_id
        WHEN excluded.latest_title_timestamp > conversation_summaries.latest_title_timestamp THEN excluded.latest_title_event_id
        WHEN excluded.latest_title_timestamp = conversation_summaries.latest_title_timestamp
          AND excluded.latest_title_event_id > conversation_summaries.latest_title_event_id THEN excluded.latest_title_event_id
        ELSE conversation_summaries.latest_title_event_id
      END,
      updated_at = datetime('now');

    INSERT INTO conversation_summary_titles (
      source, source_account_key, conversation_id, title,
      first_seen, last_seen, message_count
    ) VALUES (
      ${ref}.source,
      ${sourceAccountKeySql(ref)},
      ${ref}.conversation_id,
      ${ref}.title,
      ${ref}.timestamp,
      ${ref}.timestamp,
      1
    ) ON CONFLICT(source, source_account_key, conversation_id, title) DO UPDATE SET
      first_seen = CASE
        WHEN conversation_summary_titles.first_seen IS NULL THEN excluded.first_seen
        WHEN excluded.first_seen IS NULL THEN conversation_summary_titles.first_seen
        WHEN excluded.first_seen < conversation_summary_titles.first_seen THEN excluded.first_seen
        ELSE conversation_summary_titles.first_seen
      END,
      last_seen = CASE
        WHEN conversation_summary_titles.last_seen IS NULL THEN excluded.last_seen
        WHEN excluded.last_seen IS NULL THEN conversation_summary_titles.last_seen
        WHEN excluded.last_seen > conversation_summary_titles.last_seen THEN excluded.last_seen
        ELSE conversation_summary_titles.last_seen
      END,
      message_count = conversation_summary_titles.message_count + 1;
  `;
  const recomputeFor = (ref: "NEW" | "OLD") => `
    DELETE FROM conversation_summary_titles
    WHERE source = ${ref}.source
      AND source_account_key = ${sourceAccountKeySql(ref)}
      AND conversation_id = ${ref}.conversation_id;

    DELETE FROM conversation_summaries
    WHERE source = ${ref}.source
      AND source_account_key = ${sourceAccountKeySql(ref)}
      AND conversation_id = ${ref}.conversation_id;

    INSERT INTO conversation_summaries (
      source, source_account, source_account_key, conversation_id,
      title, message_count, first_message, last_message,
      latest_title_timestamp, latest_title_event_id, updated_at
    )
    SELECT
      g.source, g.source_account, g.source_account_key, g.conversation_id,
      latest.title, g.message_count, g.first_message, g.last_message,
      latest.timestamp, latest.id, datetime('now')
    FROM (
      SELECT
        e.source,
        e.source_account,
        ${sourceAccountKeySql("e")} AS source_account_key,
        e.conversation_id AS conversation_id,
        COUNT(*) AS message_count,
        MIN(e.timestamp) AS first_message,
        MAX(e.timestamp) AS last_message
      FROM events e
      WHERE ${eventCondition}
        AND e.source = ${ref}.source
        AND e.source_account IS ${ref}.source_account
        AND e.conversation_id = ${ref}.conversation_id
      GROUP BY e.source, e.source_account, source_account_key, e.conversation_id
    ) g
    JOIN events latest ON latest.id = (
      SELECT e2.id FROM events e2
      WHERE ${latestEventCondition}
        AND e2.source = g.source
        AND e2.source_account IS g.source_account
        AND e2.conversation_id = g.conversation_id
      ORDER BY e2.timestamp DESC, e2.id DESC
      LIMIT 1
    );

    INSERT INTO conversation_summary_titles (
      source, source_account_key, conversation_id, title,
      first_seen, last_seen, message_count
    )
    SELECT
      e.source,
      ${sourceAccountKeySql("e")} AS source_account_key,
      e.conversation_id,
      e.title,
      MIN(e.timestamp),
      MAX(e.timestamp),
      COUNT(*)
    FROM events e
    WHERE ${eventCondition}
      AND e.source = ${ref}.source
      AND e.source_account IS ${ref}.source_account
      AND e.conversation_id = ${ref}.conversation_id
    GROUP BY e.source, source_account_key, e.conversation_id, e.title;
  `;

  const eligible = (ref: "NEW" | "OLD") => `${conversationEventEligibilityClause(`${ref}.`)} AND ${ref}.conversation_id IS NOT NULL`;
  ensureTrigger(db, "conversation_summaries_ai", `CREATE TRIGGER conversation_summaries_ai AFTER INSERT ON events WHEN ${eligible("NEW")} BEGIN ${insertFor("NEW")} END`);
  ensureTrigger(db, "conversation_summaries_ad", `CREATE TRIGGER conversation_summaries_ad AFTER DELETE ON events WHEN ${eligible("OLD")} BEGIN ${recomputeFor("OLD")} END`);
  ensureTrigger(db, "conversation_summaries_au", `CREATE TRIGGER conversation_summaries_au AFTER UPDATE ON events WHEN ${eligible("OLD")} OR ${eligible("NEW")} BEGIN ${recomputeFor("OLD")} ${recomputeFor("NEW")} END`);
}

export function dropEventPeopleTriggers(db: Database): void {
  db.exec(`DROP TRIGGER IF EXISTS events_people_ai`);
  db.exec(`DROP TRIGGER IF EXISTS events_people_au`); // old combined trigger, replaced by split
  db.exec(`DROP TRIGGER IF EXISTS events_people_au_delete`);
  db.exec(`DROP TRIGGER IF EXISTS events_people_au_insert`);
  db.exec(`DROP TRIGGER IF EXISTS events_people_ad`);
  // Identity triggers (event_count + normalized_name)
  db.exec(`DROP TRIGGER IF EXISTS event_people_identity_ai`);
  db.exec(`DROP TRIGGER IF EXISTS event_people_identity_ad`);
  db.exec(`DROP TRIGGER IF EXISTS identities_ai_event_count`);
  db.exec(`DROP TRIGGER IF EXISTS identities_ai_normalized_name`);
  db.exec(`DROP TRIGGER IF EXISTS identities_au_normalized_name`);
}

// Trigger SQL definitions for event_people (used by ensureEventPeopleTriggers)
const EVENT_PEOPLE_TRIGGERS = {
  events_people_ai: `CREATE TRIGGER events_people_ai AFTER INSERT ON events
    WHEN NEW.people IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO event_people (event_id, person, source, timestamp, is_sender)
      SELECT NEW.id, value, NEW.source, NEW.timestamp, CASE WHEN key = 0 THEN 1 ELSE 0 END
      FROM json_each(NEW.people)
      WHERE value IS NOT NULL AND value != '';
    END`,
  events_people_au_delete: `CREATE TRIGGER events_people_au_delete BEFORE UPDATE ON events
    BEGIN
      DELETE FROM event_people WHERE event_id = OLD.id;
    END`,
  events_people_au_insert: `CREATE TRIGGER events_people_au_insert AFTER UPDATE ON events
    WHEN NEW.people IS NOT NULL
    BEGIN
      INSERT INTO event_people (event_id, person, source, timestamp, is_sender)
      SELECT DISTINCT NEW.id, value, NEW.source, NEW.timestamp, CASE WHEN key = 0 THEN 1 ELSE 0 END
      FROM json_each(NEW.people)
      WHERE value IS NOT NULL AND value != '';
    END`,
  events_people_ad: `CREATE TRIGGER events_people_ad AFTER DELETE ON events
    BEGIN
      DELETE FROM event_people WHERE event_id = OLD.id;
    END`,
  // Triggers to maintain identities.event_count when event_people changes
  event_people_identity_ai: `CREATE TRIGGER event_people_identity_ai AFTER INSERT ON event_people
    BEGIN
      UPDATE identities
      SET event_count = event_count + 1
      WHERE instr(NEW.person, ':') > 0
        AND platform = substr(NEW.person, 1, instr(NEW.person, ':') - 1)
        AND platform_id = substr(NEW.person, instr(NEW.person, ':') + 1);
    END`,
  event_people_identity_ad: `CREATE TRIGGER event_people_identity_ad AFTER DELETE ON event_people
    BEGIN
      UPDATE identities
      SET event_count = MAX(0, event_count - 1)
      WHERE instr(OLD.person, ':') > 0
        AND platform = substr(OLD.person, 1, instr(OLD.person, ':') - 1)
        AND platform_id = substr(OLD.person, instr(OLD.person, ':') + 1);
    END`,
};

// Trigger to initialize event_count when a new identity is created
// This handles identities created after event_people already has matching rows
const IDENTITY_TRIGGERS = {
  identities_ai_event_count: `CREATE TRIGGER identities_ai_event_count AFTER INSERT ON identities
    BEGIN
      UPDATE identities
      SET event_count = (
        SELECT COUNT(*) FROM event_people
        WHERE person = (NEW.platform || ':' || NEW.platform_id)
      )
      WHERE id = NEW.id;
    END`,
  // Maintain normalized_name on INSERT (when not already set by the INSERT statement)
  identities_ai_normalized_name: `CREATE TRIGGER identities_ai_normalized_name AFTER INSERT ON identities
    WHEN NEW.normalized_name IS NULL
    BEGIN
      UPDATE identities
      SET normalized_name = ${NORMALIZE_NAME_EXPR('NEW')}
      WHERE id = NEW.id;
    END`,
  // Maintain normalized_name on UPDATE of name-related columns
  identities_au_normalized_name: `CREATE TRIGGER identities_au_normalized_name AFTER UPDATE OF display_name, username, platform_id ON identities
    BEGIN
      UPDATE identities
      SET normalized_name = ${NORMALIZE_NAME_EXPR('NEW')}
      WHERE id = NEW.id;
    END`,
};

export function createEventPeopleTriggers(db: Database): void {
  // Unconditionally create all triggers (used after dropEventPeopleTriggers for rebuilds)
  for (const sql of Object.values(EVENT_PEOPLE_TRIGGERS)) {
    db.exec(sql);
  }
  for (const sql of Object.values(IDENTITY_TRIGGERS)) {
    db.exec(sql);
  }
}

export function ensureEventPeopleTriggers(db: Database): void {
  // Drop old combined trigger if it exists (migration from old schema)
  db.exec(`DROP TRIGGER IF EXISTS events_people_au`);

  // Conditionally create/update triggers only if they differ from expected
  for (const [name, sql] of Object.entries(EVENT_PEOPLE_TRIGGERS)) {
    ensureTrigger(db, name, sql);
  }
  for (const [name, sql] of Object.entries(IDENTITY_TRIGGERS)) {
    ensureTrigger(db, name, sql);
  }
}

export interface TimelineEvent {
  id: number;
  source: string;
  source_id: string | null;
  source_account: string | null;
  type: string;
  timestamp: string | null;
  end_timestamp: string | null;
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
  source_deleted_observed_at: string | null;
  // Count of captured earlier versions (event_versions rows); only populated
  // by conversation queries.
  version_count?: number;
}

export interface Contact {
  id: number;
  display_name: string;
  notes: string | null;
  date_of_birth: string | null;
  hidden: number; // 0 = visible, 1 = hidden
  is_self: number; // 1 = this contact is the user (at most one)
  created_at: string;
  updated_at: string;
}

export interface ContactMemory {
  id: number;
  contact_id: number;
  content: string;
  created_at: string;
}

export interface ContactAlias {
  id: number;
  contact_id: number;
  alias: string;
  source: string | null; // null = matches any source
  created_at: string;
}

export interface SkippedAlias {
  alias: string;
  source: string;
  skipped_at: string;
}

export interface Identity {
  id: number;
  platform: string;
  platform_id: string;
  display_name: string | null;
  username: string | null;
  contact_id: number | null;
  skipped: number; // 0 = not skipped, 1 = skipped
  event_count: number; // Denormalized count from event_people
  first_seen: string;
  last_seen: string;
  avatar_url: string | null;
}

export interface Attachment {
  id: number;
  event_id: number;
  source: string;
  source_id: string | null;
  content_hash: string | null;
  filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  storage_path: string | null;
  original_uri: string | null;
  status: AttachmentStatus;
  thumbhash: string | null;
  created_at: string;
}

export interface AttachmentDescription {
  content_hash: string;
  model: string;
  description: string;
  created_at: string;
}

export interface DiscordEmoji {
  emoji_id: string;
  name: string;
  /** null=unknown, 0=known static, 1=known animated. */
  animated: number | null;
  ext: string | null;
  content_hash: string | null;
  storage_path: string | null;
  file_size: number | null;
  status: "pending" | "stored" | "tombstoned";
  first_seen: string;
  last_seen: string;
  fetched_at: string | null;
}

export interface DiscordGuildEmoji {
  guild_id: string;
  emoji_id: string;
  name: string;
  animated: number;
  available: number | null;
  managed: number | null;
  require_colons: number | null;
  uploader_id: string | null;
  uploader_username: string | null;
  uploader_display_name: string | null;
  uploader_avatar_url: string | null;
  raw_data: string;
  first_seen: string;
  last_seen: string;
  deleted_at: string | null;
}

export interface Place {
  place_id: string;
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: string;
  created_at: string;
}

export interface ContactMatchSuggestion {
  id: number;
  alias_a: string;
  source_a: string | null;
  alias_b: string;
  source_b: string | null;
  score: number;
  match_type: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  reviewed_at: string | null;
}
