/**
 * Run one sync source once, in-process, against the databases this process is
 * configured for (TIMELINE_DB_PATH and the app-state.db beside it), and report
 * what it changed. `bun run sync:once` (src/sync/once-cli.ts) wraps this in a
 * scratch sandbox; tests call it directly under the test preload's isolation.
 */

import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getAppStateDb, setSyncState } from "../db/app-state";
import { getDb, initDb } from "../db/schema";
import { loadConfig } from "../config";
import { loadSyncConfig, resolveSyncIntervalMs, upsertSyncSourcePatch, validateSettingsPatch } from "./config";
import { runSyncSource } from "./run";
import { SYNC_SOURCES } from "./sources";
import type { SyncLogEntry, SyncResult, SyncSource, SyncSourceConfigField } from "./types";

export interface RunSourceOnceOptions {
  /** Source settings, validated against the source's configSchema. */
  config?: Record<string, unknown>;
  /** sync_state rows to write before the run, keyed by sync_state.source. */
  state?: Record<string, unknown>;
  /**
   * Stop after canSync(), which sees the settings and state above. Those are still
   * written and canSync() may write too, so a caller wanting its databases
   * untouched runs against copies, as the CLI does.
   */
  dryRun?: boolean;
  verbose?: boolean;
  signal?: AbortSignal;
  /** Sample rows reported per change kind. */
  sampleLimit?: number;
}

export interface EventSample {
  id: number;
  type: string;
  timestamp: string | null;
  source_account: string | null;
  title: string | null;
}

export interface EventChanges {
  count: number;
  byType: Record<string, number>;
  samples: EventSample[];
}

export interface SourceRunReport {
  source: string;
  dryRun: boolean;
  /** The settings the source saw, after validation. */
  config: Record<string, unknown>;
  /** canSync()'s refusal, or null when the source can run. */
  cannotSync: string | null;
  /** Null for a dry run. */
  result: SyncResult | null;
  syncLog: SyncLogEntry | null;
  events: { inserted: EventChanges; updated: EventChanges; deleted: number };
  /** Every sync_state row after the run, keyed by sync_state.source. */
  state: Record<string, unknown>;
}

export class SourceRunError extends Error {}

export function findSyncSource(name: string): SyncSource {
  const source = SYNC_SOURCES.find((candidate) => candidate.name === name);
  if (!source) {
    const known = SYNC_SOURCES.map((candidate) => candidate.name).sort().join(", ");
    throw new SourceRunError(`Unknown sync source "${name}". Known sources: ${known}`);
  }
  return source;
}

/**
 * Turns `key=value` assignments into typed settings using the source's
 * configSchema. Repeating a `string-list` key appends to the list.
 */
export function parseSettingAssignments(
  source: SyncSource,
  assignments: string[],
  baseDir: string = process.cwd(),
): Record<string, unknown> {
  const fields = new Map((source.configSchema ?? []).map((field) => [field.key, field]));
  const settings: Record<string, unknown> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new SourceRunError(`Expected key=value, got "${assignment}"`);
    const key = assignment.slice(0, separator);
    const raw = assignment.slice(separator + 1);
    const field = fields.get(key);
    if (!field) throw new SourceRunError(unknownKeyMessage(source, key));
    if (field.type === "string-list") {
      const list = (settings[key] as string[] | undefined) ?? [];
      list.push(raw);
      settings[key] = list;
    } else {
      settings[key] = coerceSetting(field, raw, baseDir);
    }
  }
  return settings;
}

function coerceSetting(field: SyncSourceConfigField, raw: string, baseDir: string): unknown {
  if (field.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new SourceRunError(`${field.key} must be true or false, got "${raw}"`);
  }
  if (field.type === "number") {
    const value = raw.trim() === "" ? Number.NaN : Number(raw);
    if (Number.isNaN(value)) throw new SourceRunError(`${field.key} must be a number, got "${raw}"`);
    return value;
  }
  // `~` stays for the source to expand.
  if (field.type === "string" && field.format === "path" && !raw.startsWith("~")) return resolve(baseDir, raw);
  return raw;
}

function unknownKeyMessage(source: SyncSource, key: string): string {
  const keys = (source.configSchema ?? []).map((field) => field.key);
  return keys.length === 0
    ? `${source.name} declares no settings, so "${key}" cannot be set`
    : `Unknown setting "${key}" for ${source.name}. Settings: ${keys.join(", ")}`;
}

/** Validates settings the way the sync-source API does, then checks required fields. */
export function resolveSourceSettings(source: SyncSource, config: Record<string, unknown>): Record<string, unknown> {
  const schema = source.configSchema ?? [];
  const known = new Set(schema.map((field) => field.key));
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new SourceRunError(unknownKeyMessage(source, key));
  }
  const validated = validateSettingsPatch(config, schema);
  if ("error" in validated) throw new SourceRunError(validated.error);
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validated.settings)) {
    if (value === null) throw new SourceRunError(`settings.${key} must not be null`);
    settings[key] = value;
  }
  const missing = schema
    .filter((field) => field.required && field.default === undefined && settings[field.key] === undefined)
    .map((field) => field.key);
  if (missing.length > 0) {
    throw new SourceRunError(`Missing required setting(s) for ${source.name}: ${missing.join(", ")}`);
  }
  return settings;
}

const SNAPSHOT = "sync_once_snapshot";

interface EventsSnapshot {
  /** Diffs events against the snapshot; call once, after the run. */
  diff(sampleLimit: number): SourceRunReport["events"];
  remove(): void;
}

/**
 * Copies events to a file outside the database and diffs against it afterwards,
 * so a run adds nothing to the schema: tracking triggers would outlive a killed
 * run and travel in any backup the source takes. The cost scales with the size of
 * the database, which a scratch one keeps small.
 */
function snapshotEvents(db: Database): EventsSnapshot {
  const dir = mkdtempSync(join(tmpdir(), "sync-once-snapshot-"));
  const attach = db.prepare(`ATTACH DATABASE ? AS ${SNAPSHOT}`);
  const path = join(dir, "events.db");
  attach.run(path);
  db.exec(`
    PRAGMA ${SNAPSHOT}.journal_mode = OFF;
    PRAGMA ${SNAPSHOT}.synchronous = OFF;
    CREATE TABLE ${SNAPSHOT}.events AS SELECT * FROM main.events;
    CREATE UNIQUE INDEX ${SNAPSHOT}.events_id ON events (id);
  `);
  db.exec(`DETACH DATABASE ${SNAPSHOT}`);
  const columns = (db.prepare("SELECT name FROM pragma_table_info('events')").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );

  return {
    diff(sampleLimit) {
      attach.run(path);
      try {
        const differs = columns.map((name) => `now."${name}" IS NOT was."${name}"`).join(" OR ");
        db.exec(`CREATE TABLE ${SNAPSHOT}.updated AS
          SELECT now.id FROM main.events now JOIN ${SNAPSHOT}.events was ON was.id = now.id WHERE ${differs}`);
        const deleted = db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${SNAPSHOT}.events was
             WHERE NOT EXISTS (SELECT 1 FROM main.events now WHERE now.id = was.id)`,
          )
          .get() as { count: number };
        return {
          inserted: describeChanges(db, `id NOT IN (SELECT id FROM ${SNAPSHOT}.events)`, sampleLimit),
          updated: describeChanges(db, `id IN (SELECT id FROM ${SNAPSHOT}.updated)`, sampleLimit),
          deleted: deleted.count,
        };
      } finally {
        db.exec(`DETACH DATABASE ${SNAPSHOT}`);
      }
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function describeChanges(db: Database, where: string, sampleLimit: number): EventChanges {
  const byType: Record<string, number> = {};
  let count = 0;
  const rows = db
    .prepare(`SELECT type, COUNT(*) AS count FROM events WHERE ${where} GROUP BY type ORDER BY count DESC, type`)
    .all() as Array<{ type: string; count: number }>;
  for (const row of rows) {
    byType[row.type] = row.count;
    count += row.count;
  }
  const samples = db
    .prepare(`SELECT id, type, timestamp, source_account, title FROM events WHERE ${where} ORDER BY id LIMIT ?`)
    .all(sampleLimit) as EventSample[];
  return { count, byType, samples };
}

function readSyncState(appDb: Database): Record<string, unknown> {
  const rows = appDb.prepare("SELECT source, state FROM sync_state ORDER BY source").all() as Array<{
    source: string;
    state: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.source, JSON.parse(row.state)]));
}

const NO_CHANGES: EventChanges = { count: 0, byType: {}, samples: [] };

export async function runSourceOnce(
  sourceOrName: SyncSource | string,
  options: RunSourceOnceOptions = {},
): Promise<SourceRunReport> {
  const source = typeof sourceOrName === "string" ? findSyncSource(sourceOrName) : sourceOrName;
  if (!source.enabled) throw new SourceRunError(`Source disabled: ${source.name}`);
  const settings = resolveSourceSettings(source, options.config ?? {});
  const sampleLimit = options.sampleLimit ?? 5;

  const appDb = getAppStateDb();
  // Each run sees exactly the settings it was given, not ones left by an earlier run.
  appDb.prepare("DELETE FROM sync_sources WHERE source = ?").run(source.name);
  upsertSyncSourcePatch(source.name, { enabled: true, settings }, appDb);
  for (const [key, value] of Object.entries(options.state ?? {})) setSyncState(appDb, key, value);
  const config = await loadSyncConfig(appDb);

  if (options.dryRun) {
    return {
      source: source.name,
      dryRun: true,
      config: settings,
      cannotSync: await source.canSync(config.sources[source.name]),
      result: null,
      syncLog: null,
      events: { inserted: NO_CHANGES, updated: NO_CHANGES, deleted: 0 },
      state: readSyncState(appDb),
    };
  }

  const db = getDb();
  try {
    initDb(db);
    const lastLogId = (appDb.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM sync_log").get() as { id: number }).id;
    const snapshot = snapshotEvents(db);
    try {
      // No guard: like a manual trigger, so only canSync can stop the run.
      const { result, ran } = await runSyncSource({
        appDb,
        source,
        config,
        intervalMs: resolveSyncIntervalMs(
          config.sources[source.name],
          source,
          (await loadConfig()).scheduler.default_interval,
        ),
        signal: options.signal,
        verbose: options.verbose,
      });
      return {
        source: source.name,
        dryRun: false,
        config: settings,
        cannotSync: ran ? null : (result.error ?? null),
        result,
        syncLog: appDb
          .prepare("SELECT * FROM sync_log WHERE id > ? ORDER BY id DESC LIMIT 1")
          .get(lastLogId) as SyncLogEntry | null,
        events: snapshot.diff(sampleLimit),
        state: readSyncState(appDb),
      };
    } finally {
      snapshot.remove();
    }
  } finally {
    db.close();
  }
}
