import { Hono } from "hono";
import { isValidTimeoutDelay, MAX_TIMEOUT_DELAY_MS, parseInterval } from "../config";
import { preparePackagedSyncSettings } from "../config/packaged-paths";
import { getAppStateDb } from "../db/app-state";
import { getPackagedResourceRoot } from "../runtime-paths";
import { SYNC_SOURCES } from "../sync/sources";
import {
  getSyncSourceRow,
  listSyncSourceRows,
  parseSyncSourceSettings,
  type SyncSourceRow,
  upsertSyncSourcePatch,
} from "../sync/config";
import { isRecord } from "../shared/guards";
import { notifySyncConfigChanged } from "./service-control";

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSettingsPatch(
  settings: unknown,
  schema: NonNullable<(typeof SYNC_SOURCES)[number]["configSchema"]>
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

function isEffectivelyEnabled(
  registered: { enabled: boolean },
  row: Pick<SyncSourceRow, "enabled"> | undefined | null
): boolean {
  return registered.enabled && row !== undefined && row !== null && row.enabled !== 0;
}

function serializeSource(source: string, schedulerDefaultInterval: string) {
  const appDb = getAppStateDb();
  const registered = SYNC_SOURCES.find((candidate) => candidate.name === source);
  if (!registered) return null;

  const row = getSyncSourceRow(source, appDb);
  const effectiveInterval = row?.interval ?? schedulerDefaultInterval;
  return {
    name: registered.name,
    description: registered.description,
    configured: row !== null,
    enabled: isEffectivelyEnabled(registered, row),
    interval: row?.interval ?? null,
    effectiveInterval,
    effectiveIntervalMs: parseInterval(effectiveInterval),
    defaultInterval: schedulerDefaultInterval,
    settings: row ? parseSyncSourceSettings(row) : {},
    settingsSchema: registered.configSchema ?? [],
    ...(registered.authStatus ? { authStatus: registered.authStatus() } : {}),
  };
}

export function createSyncSourceRoutes(schedulerDefaultInterval: string) {
  return new Hono()
    .get("/api/sync/sources", (c) => {
      const rows = new Map(listSyncSourceRows(getAppStateDb()).map((row) => [row.source, row]));
      const sources = SYNC_SOURCES.map((source) => {
        const row = rows.get(source.name);
        const effectiveInterval = row?.interval ?? schedulerDefaultInterval;
        return {
          name: source.name,
          description: source.description,
          configured: row !== undefined,
          enabled: isEffectivelyEnabled(source, row),
          interval: row?.interval ?? null,
          effectiveInterval,
          effectiveIntervalMs: parseInterval(effectiveInterval),
          defaultInterval: schedulerDefaultInterval,
          settings: row ? parseSyncSourceSettings(row) : {},
          settingsSchema: source.configSchema ?? [],
          ...(source.authStatus ? { authStatus: source.authStatus() } : {}),
        };
      });
      return c.json({ sources });
    })

    .patch("/api/sync/sources/:source", async (c) => {
      const source = c.req.param("source");
      if (!SYNC_SOURCES.some((candidate) => candidate.name === source)) {
        return c.json({ error: `Unknown sync source: ${source}` }, 404);
      }

      const body = await c.req.json().catch(() => null);
      if (!isPlainJsonObject(body)) {
        return c.json({ error: "Expected JSON object body" }, 400);
      }

      const bodyRecord = body as Record<string, unknown>;
      const keys = Object.keys(bodyRecord);
      if (keys.length === 0) {
        return c.json({ error: "PATCH /api/sync/sources/:source accepts enabled, interval, and/or settings" }, 400);
      }
      if (keys.some((key) => key !== "enabled" && key !== "interval" && key !== "settings")) {
        return c.json({ error: "PATCH /api/sync/sources/:source only accepts enabled, interval, and settings" }, 400);
      }

      const patch: {
        enabled?: boolean;
        interval?: string | null;
        settings?: Record<string, unknown | null>;
      } = {};

      if ("enabled" in bodyRecord) {
        if (typeof bodyRecord.enabled !== "boolean") {
          return c.json({ error: "enabled must be a boolean", field: "enabled" }, 400);
        }
        patch.enabled = bodyRecord.enabled;
      }

      if ("interval" in bodyRecord) {
        if (bodyRecord.interval !== null && typeof bodyRecord.interval !== "string") {
          return c.json(
            { error: "interval must be a duration string or null", field: "interval" },
            400
          );
        }
        if (typeof bodyRecord.interval === "string") {
          try {
            const intervalMs = parseInterval(bodyRecord.interval);
            if (intervalMs <= 0 || !isValidTimeoutDelay(intervalMs)) {
              return c.json(
                {
                  error:
                    `interval must be greater than 0ms and no more than ${MAX_TIMEOUT_DELAY_MS}ms`,
                  field: "interval",
                },
                400
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return c.json({ error: message, field: "interval" }, 400);
          }
        }
        patch.interval = bodyRecord.interval;
      }

      if ("settings" in bodyRecord) {
        const registered = SYNC_SOURCES.find((candidate) => candidate.name === source);
        if (!registered?.configSchema) {
          return c.json(
            { error: "settings are not editable for this source", field: "settings" },
            400
          );
        }
        const validated = validateSettingsPatch(bodyRecord.settings, registered.configSchema);
        if ("error" in validated) return c.json(validated, 400);
        if (getPackagedResourceRoot()) {
          try {
            preparePackagedSyncSettings(
              source,
              validated.settings,
              registered.configSchema,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return c.json({ error: message, field: "settings" }, 400);
          }
        }
        patch.settings = validated.settings;
      }

      upsertSyncSourcePatch(source, patch, getAppStateDb());
      notifySyncConfigChanged();

      const serialized = serializeSource(source, schedulerDefaultInterval);
      if (!serialized) {
        return c.json({ error: `Unknown sync source: ${source}` }, 404);
      }
      return c.json(serialized);
    });
}
