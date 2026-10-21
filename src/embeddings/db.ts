import { Database } from "bun:sqlite";
import { getEmbeddingsDbPath as deriveEmbeddingsDbPath, getTimelineDbPath } from "../db/paths";
import type { QueryExecutor } from "../db/pool";
import { configureBunSqliteForSqliteVec, loadSqliteVec, serializeVector } from "./sqlite-vec";

export interface ContentProfile {
  id: number;
  name: string;
  formatter: string;
  version: number;
}

export interface ModelProfile {
  id: number;
  name: string;
  provider: string;
  endpoint: string;
  model: string;
  dimensions: number;
  api_key_env: string | null;
  /** Text prepended to every document this profile embeds; part of its vector space. */
  document_prefix: string;
}

export interface UpsertDocumentInput {
  sourceKind: string;
  sourceKey: string;
  title: string | null;
  snippet: string | null;
  startTimestamp: string | null;
  endTimestamp: string | null;
  contentProfileId: number;
  contentProfileVersion: number;
  renderedContent: string;
  contentHash: string;
  eventIds: number[];
}

interface DimensionsRow {
  dimensions: number;
}

export function getEmbeddingsDbPath(timelineDbPath = getTimelineDbPath()): string {
  if (process.env.TIMELINE_EMBEDDINGS_DB_PATH) return process.env.TIMELINE_EMBEDDINGS_DB_PATH;
  return deriveEmbeddingsDbPath(timelineDbPath);
}

export function getEmbeddingsDb(path = getEmbeddingsDbPath(), options: { readonly?: boolean } = {}): Database {
  configureBunSqliteForSqliteVec();
  const db = new Database(path, options.readonly ? { readonly: true } : undefined);
  if (!options.readonly) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 30000");
  return db;
}

/** Requested memory map for a search connection: larger than any embeddings.db. */
const SEARCH_MMAP_BYTES = 64 * 1024 ** 3;

/** Open embeddings.db read-only for nearest-neighbour search. */
export function openVectorSearchDb(path = getEmbeddingsDbPath()): Database {
  const db = getEmbeddingsDb(path, { readonly: true });
  try {
    loadSqliteVec(db);
    // The KNN scan reads every vector; memory-mapping skips copying them through
    // SQLite's page cache. SQLite clamps this to its compile-time maximum.
    db.exec(`PRAGMA mmap_size = ${SEARCH_MMAP_BYTES}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function initEmbeddingsDb(db: Database): void {
  loadSqliteVec(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      formatter TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (name, version)
    );

    CREATE TABLE IF NOT EXISTS embedding_model_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      api_key_env TEXT,
      document_prefix TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embedding_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      title TEXT,
      snippet TEXT,
      start_timestamp TEXT,
      end_timestamp TEXT,
      content_profile_id INTEGER NOT NULL REFERENCES content_profiles(id),
      content_profile_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      rendered_content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (content_profile_id, content_hash)
    );

    CREATE TABLE IF NOT EXISTS embedding_document_events (
      document_id INTEGER NOT NULL REFERENCES embedding_documents(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'primary',
      PRIMARY KEY (document_id, event_id, position)
    );

    CREATE TABLE IF NOT EXISTS embedding_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES embedding_documents(id) ON DELETE CASCADE,
      model_profile_id INTEGER NOT NULL REFERENCES embedding_model_profiles(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (document_id, model_profile_id)
    );

    -- How far the background indexer has walked events.id for one content and
    -- model profile pair; events at or below last_event_id have been indexed.
    CREATE TABLE IF NOT EXISTS embedding_index_cursors (
      content_profile_id INTEGER NOT NULL REFERENCES content_profiles(id),
      model_profile_id INTEGER NOT NULL REFERENCES embedding_model_profiles(id),
      last_event_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (content_profile_id, model_profile_id)
    );

    -- Sources the indexer could not embed (an image missing from media storage
    -- or one that cannot be decoded), so later runs skip them.
    CREATE TABLE IF NOT EXISTS embedding_failures (
      content_profile_id INTEGER NOT NULL REFERENCES content_profiles(id),
      model_profile_id INTEGER NOT NULL REFERENCES embedding_model_profiles(id),
      source_key TEXT NOT NULL,
      reason TEXT NOT NULL,
      failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (content_profile_id, model_profile_id, source_key)
    );
  `);
  if (!hasDocumentPrefixColumn(db)) {
    // Profiles created before the column existed never prefixed their documents.
    db.exec("ALTER TABLE embedding_model_profiles ADD COLUMN document_prefix TEXT NOT NULL DEFAULT ''");
  }
}

const MODEL_PROFILE_COLUMNS_SQL = "PRAGMA table_info(embedding_model_profiles)";

function includesDocumentPrefix(columns: Array<{ name: string }>): boolean {
  return columns.some(column => column.name === "document_prefix");
}

function hasDocumentPrefixColumn(db: Database): boolean {
  return includesDocumentPrefix(db.prepare(MODEL_PROFILE_COLUMNS_SQL).all() as Array<{ name: string }>);
}

/**
 * Which documents a vector table holds. Event text and attachment images share
 * a model's vector space but sit in separate tables, so each kind is ranked on
 * its own: text lies closer to text queries than images do, and would crowd
 * images out of a single ranking.
 */
export type VectorKind = "event" | "attachment";

function vecTableName(modelProfileId: number, kind: VectorKind = "event"): string {
  // The id comes from embedding_model_profiles (an AUTOINCREMENT rowid), so it is
  // always a positive integer — guard anyway since it is interpolated into SQL.
  if (!Number.isInteger(modelProfileId) || modelProfileId <= 0) {
    throw new Error(`Invalid embedding model profile id: ${modelProfileId}`);
  }
  return kind === "event" ? `vec_model_${modelProfileId}` : `vec_model_${modelProfileId}_${kind}`;
}

// Each model profile owns its own sqlite-vec tables, fixed to that profile's
// vector width. vec0 bakes the width into the table at creation, so per-profile
// tables are what let models of different dimensions share one embeddings.db.
// The tables are created when the profile is loaded and persist with it, so
// every caller holding a model_profile_id can assume they exist.
function ensureVecTables(db: Database, modelProfileId: number, dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error("sqlite-vec dimensions must be a positive integer");
  }
  for (const kind of ["event", "attachment"] as const) {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTableName(modelProfileId, kind)} USING vec0(embedding float[${dimensions}])`
    );
  }
}

export function ensureContentProfile(db: Database, profile: Omit<ContentProfile, "id">): ContentProfile {
  db.prepare("INSERT OR IGNORE INTO content_profiles (name, formatter, version) VALUES (?, ?, ?)").run(
    profile.name,
    profile.formatter,
    profile.version
  );
  const row = db
    .prepare("SELECT id, name, formatter, version FROM content_profiles WHERE name = ? AND version = ?")
    .get(profile.name, profile.version) as ContentProfile | null;
  if (!row) throw new Error(`Failed to load content profile ${profile.name}:v${profile.version}`);
  return row;
}

export function ensureModelProfile(db: Database, profile: Omit<ModelProfile, "id">): ModelProfile {
  if (!Number.isInteger(profile.dimensions) || profile.dimensions <= 0) {
    throw new Error("Embedding model profile dimensions must be a positive integer");
  }

  const existing = db
    .prepare("SELECT id, name, provider, endpoint, model, dimensions, api_key_env, document_prefix FROM embedding_model_profiles WHERE name = ?")
    .get(profile.name) as ModelProfile | null;

  let resolved: ModelProfile;
  if (existing) {
    // A profile name is the stable handle its id is minted from, and every stored
    // vector is keyed to that id in a vec0 table of fixed width. Repointing the
    // name at a different model — or a different dimension — would leave vectors
    // produced by the old config incomparable with queries embedded by the new
    // one, yet hasVector would still report them present and skip re-embedding,
    // silently corrupting search. Refuse instead.
    if (existing.model !== profile.model) {
      throw new Error(
        `Embedding model profile "${profile.name}" is already bound to model "${existing.model}"; ` +
          `refusing to repoint it at "${profile.model}". Choose a different [embeddings] profile ` +
          `or re-index into a fresh embeddings.db.`
      );
    }
    if (existing.dimensions !== profile.dimensions) {
      throw new Error(
        `Embedding model profile "${profile.name}" is already bound to ${existing.dimensions} dimensions; ` +
          `refusing to rebind it to ${profile.dimensions}. Choose a different [embeddings] profile ` +
          `or re-index into a fresh embeddings.db.`
      );
    }
    if (existing.document_prefix !== profile.document_prefix) {
      throw new Error(
        `Embedding model profile "${profile.name}" was indexed with document prefix ${JSON.stringify(existing.document_prefix)}; ` +
          `refusing to switch it to ${JSON.stringify(profile.document_prefix)}. Choose a different [embeddings] profile ` +
          `or re-index into a fresh embeddings.db.`
      );
    }
    // Operational fields don't change the vector space; keep the record current.
    db.prepare("UPDATE embedding_model_profiles SET provider = ?, endpoint = ?, api_key_env = ? WHERE id = ?").run(
      profile.provider,
      profile.endpoint,
      profile.api_key_env,
      existing.id
    );
    resolved = { ...existing, provider: profile.provider, endpoint: profile.endpoint, api_key_env: profile.api_key_env };
  } else {
    const result = db
      .prepare(
        `INSERT INTO embedding_model_profiles (name, provider, endpoint, model, dimensions, api_key_env, document_prefix)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profile.name,
        profile.provider,
        profile.endpoint,
        profile.model,
        profile.dimensions,
        profile.api_key_env,
        profile.document_prefix
      );
    resolved = {
      id: Number(result.lastInsertRowid),
      name: profile.name,
      provider: profile.provider,
      endpoint: profile.endpoint,
      model: profile.model,
      dimensions: profile.dimensions,
      api_key_env: profile.api_key_env,
      document_prefix: profile.document_prefix,
    };
  }

  ensureVecTables(db, resolved.id, resolved.dimensions);
  return resolved;
}

/**
 * Load the model profile selected by a read-only search without changing it. A
 * read-only handle cannot run initEmbeddingsDb's migration, so a database last
 * written before the document_prefix column existed reads as unprefixed — which
 * is how every profile from that era was indexed.
 */
export function getModelProfile(db: Database, name: string): ModelProfile | null {
  return db.prepare(modelProfileSql(hasDocumentPrefixColumn(db))).get(name) as ModelProfile | null;
}

/** getModelProfile through a read-only query executor. */
export async function readModelProfile(db: QueryExecutor, name: string): Promise<ModelProfile | null> {
  const columns = await db.query<{ name: string }>(MODEL_PROFILE_COLUMNS_SQL);
  return db.get<ModelProfile>(modelProfileSql(includesDocumentPrefix(columns)), name);
}

function modelProfileSql(hasDocumentPrefix: boolean): string {
  const documentPrefix = hasDocumentPrefix ? "document_prefix" : "'' AS document_prefix";
  return `SELECT id, name, provider, endpoint, model, dimensions, api_key_env, ${documentPrefix} FROM embedding_model_profiles WHERE name = ?`;
}

export function upsertDocument(db: Database, input: UpsertDocumentInput): { id: number; created: boolean } {
  const selectExisting = db.prepare("SELECT id FROM embedding_documents WHERE content_profile_id = ? AND content_hash = ?");
  const before = selectExisting.get(input.contentProfileId, input.contentHash) as { id: number } | null;
  if (before) {
    upsertDocumentEvents(db, before.id, input.eventIds);
    return { id: before.id, created: false };
  }

  // Another index run may insert the same document between the SELECT and here.
  const inserted = db
    .prepare(
      `INSERT INTO embedding_documents (
        source_kind, source_key, title, snippet, start_timestamp, end_timestamp,
        content_profile_id, content_profile_version, content_hash, rendered_content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (content_profile_id, content_hash) DO NOTHING
      RETURNING id`
    )
    .get(
      input.sourceKind,
      input.sourceKey,
      input.title,
      input.snippet,
      input.startTimestamp,
      input.endTimestamp,
      input.contentProfileId,
      input.contentProfileVersion,
      input.contentHash,
      input.renderedContent
    ) as { id: number } | null;
  const document = inserted ?? (selectExisting.get(input.contentProfileId, input.contentHash) as { id: number } | null);
  if (!document) throw new Error(`Embedding document ${input.contentHash} was neither inserted nor found`);
  upsertDocumentEvents(db, document.id, input.eventIds);
  return { id: document.id, created: inserted !== null };
}

function upsertDocumentEvents(db: Database, documentId: number, eventIds: number[]): void {
  const insertEvent = db.prepare(
    "INSERT OR IGNORE INTO embedding_document_events (document_id, event_id, position, role) VALUES (?, ?, ?, 'primary')"
  );
  eventIds.forEach((eventId, index) => insertEvent.run(documentId, eventId, index));
}

export function getIndexCursor(db: Database, contentProfileId: number, modelProfileId: number): number {
  const row = db
    .prepare("SELECT last_event_id FROM embedding_index_cursors WHERE content_profile_id = ? AND model_profile_id = ?")
    .get(contentProfileId, modelProfileId) as { last_event_id: number } | null;
  return row?.last_event_id ?? 0;
}

export function setIndexCursor(db: Database, contentProfileId: number, modelProfileId: number, lastEventId: number): void {
  db.prepare(
    `INSERT INTO embedding_index_cursors (content_profile_id, model_profile_id, last_event_id) VALUES (?, ?, ?)
     ON CONFLICT (content_profile_id, model_profile_id)
     DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = datetime('now')`
  ).run(contentProfileId, modelProfileId, lastEventId);
}

/** Content hashes of a content profile's documents that already have a vector for the model. */
export function listEmbeddedContentHashes(db: Database, contentProfileId: number, modelProfileId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT d.content_hash FROM embedding_documents d
       JOIN embedding_vectors v ON v.document_id = d.id
       WHERE d.content_profile_id = ? AND v.model_profile_id = ?`
    )
    .all(contentProfileId, modelProfileId) as { content_hash: string }[];
  return new Set(rows.map(row => row.content_hash));
}

export function recordEmbeddingFailure(
  db: Database,
  contentProfileId: number,
  modelProfileId: number,
  sourceKey: string,
  reason: string
): void {
  db.prepare(
    `INSERT INTO embedding_failures (content_profile_id, model_profile_id, source_key, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT (content_profile_id, model_profile_id, source_key)
     DO UPDATE SET reason = excluded.reason, failed_at = datetime('now')`
  ).run(contentProfileId, modelProfileId, sourceKey, reason);
}

export function listFailedSourceKeys(db: Database, contentProfileId: number, modelProfileId: number): Set<string> {
  const rows = db
    .prepare("SELECT source_key FROM embedding_failures WHERE content_profile_id = ? AND model_profile_id = ?")
    .all(contentProfileId, modelProfileId) as { source_key: string }[];
  return new Set(rows.map(row => row.source_key));
}

export function hasVector(db: Database, documentId: number, modelProfileId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1
       FROM embedding_vectors ev
       JOIN ${vecTableName(modelProfileId)} vec ON vec.rowid = ev.id
       WHERE ev.document_id = ? AND ev.model_profile_id = ?`
    )
    .get(documentId, modelProfileId);
  return row !== null;
}

/**
 * Store a document's vector for a model. Returns false, writing nothing, when
 * the document already has one, as when another index run stored it first.
 */
export function insertVector(
  db: Database,
  documentId: number,
  modelProfileId: number,
  vector: number[],
  kind: VectorKind = "event"
): boolean {
  assertVectorDimensions(db, modelProfileId, vector.length);
  const vecTable = vecTableName(modelProfileId, kind);
  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT ev.id, vec.rowid AS vec_rowid
         FROM embedding_vectors ev
         LEFT JOIN ${vecTable} vec ON vec.rowid = ev.id
         WHERE ev.document_id = ? AND ev.model_profile_id = ?`
      )
      .get(documentId, modelProfileId) as { id: number; vec_rowid: number | null } | null;

    if (existing?.vec_rowid !== null && existing?.vec_rowid !== undefined) return false;
    if (existing) {
      db.prepare("DELETE FROM embedding_vectors WHERE id = ?").run(existing.id);
    }

    const result = db
      .prepare("INSERT INTO embedding_vectors (document_id, model_profile_id) VALUES (?, ?)")
      .run(documentId, modelProfileId);
    db.prepare(`INSERT INTO ${vecTable}(rowid, embedding) VALUES (?, ?)`).run(
      Number(result.lastInsertRowid),
      serializeVector(vector)
    );
    return true;
  })();
}

function assertVectorDimensions(db: Database, modelProfileId: number, vectorDimensions: number): void {
  const model = db
    .prepare("SELECT dimensions FROM embedding_model_profiles WHERE id = ?")
    .get(modelProfileId) as DimensionsRow | null;
  if (!model) throw new Error(`Embedding model profile ${modelProfileId} does not exist`);
  if (vectorDimensions !== model.dimensions) {
    throw new Error(
      `Vector has ${vectorDimensions} dimensions, but model profile ${modelProfileId} expects ${model.dimensions}`
    );
  }
}

export interface SearchHit {
  document_id: number;
  event_id: number;
  distance: number;
}

export function searchVectors(db: Database, vector: number[], modelProfileId: number, limit: number): SearchHit[] {
  assertVectorDimensions(db, modelProfileId, vector.length);
  return db.prepare(searchVectorsSql(modelProfileId)).all(serializeVector(vector), limit) as SearchHit[];
}

/** searchVectors through a read-only query executor, for a profile already loaded. */
export function queryVectors(
  db: QueryExecutor,
  vector: number[],
  modelProfile: ModelProfile,
  limit: number
): Promise<SearchHit[]> {
  if (vector.length !== modelProfile.dimensions) {
    throw new Error(
      `Vector has ${vector.length} dimensions, but model profile ${modelProfile.id} expects ${modelProfile.dimensions}`
    );
  }
  return db.query<SearchHit>(searchVectorsSql(modelProfile.id), serializeVector(vector), limit);
}

function searchVectorsSql(modelProfileId: number): string {
  // The table is model-specific (every rowid in it is an embedding_vectors row for
  // this profile), so the KNN scan is already scoped — no model_profile_id filter
  // needed, and the scan only covers this model's vectors.
  return `SELECT ev.document_id, ede.event_id, v.distance
       FROM ${vecTableName(modelProfileId)} v
       JOIN embedding_vectors ev ON ev.id = v.rowid
       JOIN embedding_document_events ede ON ede.document_id = ev.document_id
       WHERE v.embedding MATCH ? AND k = ?
       ORDER BY v.distance, ede.position`;
}
