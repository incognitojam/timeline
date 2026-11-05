/**
 * Sync Configuration
 *
 * Per-source sync configuration lives in app-state.db. config.toml is only a
 * one-time bootstrap source for legacy [sync.*] sections.
 */

import type { Database } from "bun:sqlite";
import { getAppStateDb, migrateSourceBlockedNetworks } from "../db/app-state";
import type { ServiceConfig, SyncSourceConfig } from "../config/types";
import { isPlainJsonObject } from "../shared/guards";
import type { SyncSourceConfigField } from "./types";

export interface SyncConfig {
  /** Source configurations keyed by source name */
  sources: Record<string, SyncSourceConfig>;
}

export interface SyncSourceRow {
  source: string;
  enabled: number;
  interval: string | null;
  settings: string;
  updated_at: string | null;
}

export interface TomlSyncImportResult {
  imported: number;
  ignoredTomlSections: boolean;
}

type SyncLogger = Pick<typeof console, "warn" | "log">;

export function parseSyncSourceSettings(row: Pick<SyncSourceRow, "source" | "settings">): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.settings);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid sync_sources.settings for "${row.source}": ${reason}`);
  }
}

export function listSyncSourceRows(db: Database = getAppStateDb()): SyncSourceRow[] {
  return db.prepare("SELECT * FROM sync_sources ORDER BY source").all() as SyncSourceRow[];
}

export function getSyncSourceRow(source: string, db: Database = getAppStateDb()): SyncSourceRow | null {
  return db.prepare("SELECT * FROM sync_sources WHERE source = ?").get(source) as SyncSourceRow | null;
}

export function countSyncSourceRows(db: Database = getAppStateDb()): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sync_sources").get() as { count: number };
  return row.count;
}

export function loadSyncSourcesConfig(
  db: Database = getAppStateDb(),
  registeredSources?: ReadonlySet<string>,
): Record<string, SyncSourceConfig> {
  const sources: Record<string, SyncSourceConfig> = {};
  for (const row of listSyncSourceRows(db)) {
    if (registeredSources && !registeredSources.has(row.source)) continue;
    sources[row.source] = {
      ...parseSyncSourceSettings(row),
      enabled: row.enabled !== 0,
      ...(row.interval === null ? {} : { interval: row.interval }),
    };
  }
  return sources;
}

/**
 * Load sync configuration from app-state.db.
 */
export async function loadSyncConfig(
  db: Database = getAppStateDb(),
  registeredSources?: ReadonlySet<string>,
): Promise<SyncConfig> {
  return {
    sources: loadSyncSourcesConfig(db, registeredSources),
  };
}

export function getSourceConfig(
  config: SyncConfig,
  sourceName: string
): SyncSourceConfig | null {
  return config.sources[sourceName] || null;
}

export function isSyncSourceEnabled(sourceName: string, db: Database = getAppStateDb()): boolean {
  const row = getSyncSourceRow(sourceName, db);
  return row !== null && row.enabled !== 0;
}

export function upsertSyncSourcePatch(
  source: string,
  patch: {
    enabled?: boolean;
    interval?: string | null;
    settings?: Record<string, unknown | null>;
  },
  db: Database = getAppStateDb()
): SyncSourceRow {
  return db.transaction(() => {
    const existing = getSyncSourceRow(source, db);
    const existingSettings = existing ? parseSyncSourceSettings(existing) : {};
    const nextSettings = { ...existingSettings };

    for (const [key, value] of Object.entries(patch.settings ?? {})) {
      if (value === null) {
        delete nextSettings[key];
      } else {
        nextSettings[key] = value;
      }
    }

    if (existing) {
      const nextEnabled = patch.enabled ?? (existing.enabled !== 0);
      const nextInterval = "interval" in patch ? patch.interval : existing.interval;
      db.prepare(
        `UPDATE sync_sources
         SET enabled = ?, interval = ?, settings = ?, updated_at = datetime('now')
         WHERE source = ?`
      ).run(nextEnabled ? 1 : 0, nextInterval ?? null, JSON.stringify(nextSettings), source);
    } else {
      const initialEnabled = patch.enabled ?? false;
      const initialInterval = "interval" in patch ? patch.interval ?? null : null;
      db.prepare(
        `INSERT INTO sync_sources (source, enabled, interval, settings, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      ).run(source, initialEnabled ? 1 : 0, initialInterval, JSON.stringify(nextSettings));
    }

    const row = getSyncSourceRow(source, db);
    if (!row) {
      throw new Error(`Failed to update sync source "${source}"`);
    }
    return row;
  })();
}

export function hasTomlSyncSections(config: Pick<ServiceConfig, "sync">): boolean {
  return Object.keys(config.sync).length > 0;
}

function splitTomlSyncSourceConfig(source: string, config: SyncSourceConfig): {
  enabled: number;
  interval: string | null;
  settings: Record<string, unknown>;
} {
  const settings: Record<string, unknown> = {};
  let interval: string | null = null;

  for (const [key, value] of Object.entries(config)) {
    if (key === "enabled") continue;
    if (key === "interval") {
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new Error(`[sync.${source}].interval must be a string`);
      }
      interval = value ?? null;
      continue;
    }
    settings[key] = value;
  }

  return {
    enabled: config.enabled === false ? 0 : 1,
    interval,
    settings,
  };
}

export function importTomlSyncSourcesIfEmpty(
  db: Database,
  config: Pick<ServiceConfig, "sync">,
  logger: SyncLogger = console,
  registeredSources?: ReadonlySet<string>,
): TomlSyncImportResult {
  if (!hasTomlSyncSections(config)) {
    return { imported: 0, ignoredTomlSections: false };
  }

  const existingRows = countSyncSourceRows(db);
  if (existingRows > 0) {
    logger.warn(
      "WARNING: config.toml still contains [sync.*] sections, but sync source configuration now lives in app-state.db. " +
        "Those TOML sections are ignored; delete them after verifying the web UI settings."
    );
    return { imported: 0, ignoredTomlSections: true };
  }

  const insert = db.prepare(
    `INSERT INTO sync_sources (source, enabled, interval, settings, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  );

  const syncSources = Object.entries(config.sync).filter(([source]) => {
    if (!registeredSources || registeredSources.has(source)) return true;
    logger.warn(`Ignoring [sync.${source}] because the sync source is no longer registered`);
    return false;
  });
  const transaction = db.transaction((sources: Array<[string, SyncSourceConfig]>) => {
    for (const [source, sourceConfig] of sources) {
      const split = splitTomlSyncSourceConfig(source, sourceConfig);
      insert.run(source, split.enabled, split.interval, JSON.stringify(split.settings));
    }
    migrateSourceBlockedNetworks(db);
  });

  transaction(syncSources);
  logger.log(`Imported ${syncSources.length} [sync.*] section(s) into app-state.db sync_sources`);
  return { imported: syncSources.length, ignoredTomlSections: false };
}

export function validateSettingsPatch(
  settings: unknown,
  schema: SyncSourceConfigField[]
): { settings: Record<string, unknown | null> } | { error: string; field: string } {
  if (!isPlainJsonObject(settings)) {
    return { error: "settings must be a JSON object", field: "settings" };
  }

  const fields = new Map(schema.map((field) => [field.key, field]));
  const patch: Record<string, unknown | null> = {};
  for (const [key, value] of Object.entries(settings)) {
    const field = fields.get(key);
    if (!field) return { error: `Unknown settings key: ${key}`, field: `settings.${key}` };
    if (value === null) {
      patch[key] = null;
      continue;
    }

    if (field.type === "string") {
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          error: `settings.${key} must be a non-empty string`,
          field: `settings.${key}`,
        };
      }
      patch[key] = value.trim();
      continue;
    }
    if (field.type === "boolean" && typeof value !== "boolean") {
      return { error: `settings.${key} must be a boolean`, field: `settings.${key}` };
    }
    if (field.type === "string-list") {
      if (!Array.isArray(value) || value.length === 0) {
        return {
          error: `settings.${key} must be a non-empty array; use null to clear the key`,
          field: `settings.${key}`,
        };
      }
      const entries = value.map((entry) => (typeof entry === "string" ? entry.trim() : entry));
      if (entries.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        return {
          error: `settings.${key} must be an array of non-empty strings`,
          field: `settings.${key}`,
        };
      }
      patch[key] = entries;
      continue;
    }
    if (field.type === "select") {
      if (typeof value !== "string" || !field.options.includes(value.trim())) {
        return {
          error: `settings.${key} must be one of: ${field.options.join(", ")}`,
          field: `settings.${key}`,
        };
      }
      patch[key] = value.trim();
      continue;
    }
    if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return {
          error: `settings.${key} must be a finite number`,
          field: `settings.${key}`,
        };
      }
      if (field.integer && !Number.isSafeInteger(value)) {
        return {
          error: `settings.${key} must be a safe integer`,
          field: `settings.${key}`,
        };
      }
      if (field.min !== undefined && value < field.min) {
        return {
          error: `settings.${key} must be at least ${field.min}`,
          field: `settings.${key}`,
        };
      }
      if (field.max !== undefined && value > field.max) {
        return {
          error: `settings.${key} must be at most ${field.max}`,
          field: `settings.${key}`,
        };
      }
    }
    patch[key] = value;
  }
  return { settings: patch };
}

// Re-export for compatibility
export type { SyncSourceConfig } from "../config/types";
