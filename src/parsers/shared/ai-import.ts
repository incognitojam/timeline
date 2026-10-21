/**
 * Scaffolding shared by AI coding-agent SQLite importers (Conductor, T3
 * Code): per-run identity collection and the dedup/refresh event write.
 * Source queries, content-block normalization, and title/tag construction
 * stay in each parser — that's where the sources genuinely differ.
 */

import type { Database } from "bun:sqlite";
import {
  formatIdentifier,
  upsertIdentities,
  type UpsertIdentityOptions,
} from "../../db/queries";
import type { Platform } from "../../db/schema";
import { formatModelName } from "./model-names";

export interface AiImportOptions {
  dryRun?: boolean;
  refreshRawData?: boolean;
}

/**
 * Collect the user identity plus one assistant identity per model seen
 * during an import run, for a single batch upsert at the end.
 */
export function createIdentityCollector(platform: Platform, sourceAccount: string) {
  const identities = new Map<string, UpsertIdentityOptions>();

  const userIdentifier = formatIdentifier(platform, sourceAccount);
  identities.set(userIdentifier, {
    platform,
    platformId: sourceAccount,
    displayName: sourceAccount,
    username: sourceAccount,
  });

  /** Register the assistant identity for a model id; returns its identifier. */
  const registerAssistant = (modelId: string | null): string => {
    const platformId = modelId || "assistant";
    const identifier = formatIdentifier(platform, platformId);
    if (!identities.has(identifier)) {
      identities.set(identifier, {
        platform,
        platformId,
        displayName: formatModelName(modelId),
        username: platformId,
      });
    }
    return identifier;
  };

  /** Upsert every collected identity; returns how many were written. */
  const upsertAll = (db: Database): number => {
    if (identities.size === 0) return 0;
    upsertIdentities(db, [...identities.values()]);
    return identities.size;
  };

  return { userIdentifier, registerAssistant, upsertAll };
}

export interface AiEventRow {
  sourceId: string;
  eventType: string;
  timestamp: string | null;
  title: string;
  content: string;
  people: string[];
  tags: string[];
  rawData: string;
  conversationId: string;
}

export type WriteOutcome = "inserted" | "refreshed" | "skipped";

/**
 * Prepared-statement bundle for event writes with duplicate handling.
 *
 * RETURNING distinguishes inserted rows from ignored duplicates. The usual
 * `result.changes > 0` check is unreliable on the events table: its FTS5
 * triggers flush shadow-table writes lazily, inflating `changes` on
 * statements that inserted nothing.
 */
export function createEventWriter(
  db: Database,
  options: {
    source: Platform;
    sourceAccount: string;
    importBatch: string;
    refreshRawData: boolean;
  }
) {
  const { source, sourceAccount, importBatch, refreshRawData } = options;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `);

  const updateRefresh = db.prepare(`
    UPDATE events SET content = ?, raw_data = ?, conversation_id = ?
    WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  const findStmt = db.prepare(`
    SELECT id FROM events
    WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  const findExisting = (sourceId: string): number | null => {
    const row = findStmt.get(source, sourceId, sourceAccount) as { id: number } | undefined;
    return row?.id ?? null;
  };

  /** Insert one event row; on duplicate, refresh content+raw_data+conversation_id when enabled. */
  const write = (event: AiEventRow): { outcome: WriteOutcome; eventId: number | null } => {
    const inserted = insert.get(
      source,
      event.sourceId,
      sourceAccount,
      event.eventType,
      event.timestamp,
      event.title,
      event.content,
      JSON.stringify(event.people),
      event.tags.length > 0 ? JSON.stringify(event.tags) : null,
      event.rawData,
      importBatch,
      event.conversationId
    ) as { id: number } | null;
    if (inserted !== null) return { outcome: "inserted", eventId: inserted.id };

    const existingId = findExisting(event.sourceId);
    if (refreshRawData) {
      updateRefresh.run(event.content, event.rawData, event.conversationId, source, event.sourceId, sourceAccount);
      return { outcome: "refreshed", eventId: existingId };
    }
    return { outcome: "skipped", eventId: existingId };
  };

  return { write, findExisting };
}
