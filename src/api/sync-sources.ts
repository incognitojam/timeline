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
  validateSettingsPatch,
} from "../sync/config";
import { isPlainJsonObject } from "../shared/guards";
import { notifySyncConfigChanged } from "./service-control";

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
  const defaultInterval = registered.defaultInterval ?? schedulerDefaultInterval;
  const effectiveInterval = row?.interval ?? defaultInterval;
  return {
    name: registered.name,
    description: registered.description,
    configured: row !== null,
    enabled: isEffectivelyEnabled(registered, row),
    interval: row?.interval ?? null,
    effectiveInterval,
    effectiveIntervalMs: parseInterval(effectiveInterval),
    defaultInterval,
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
        const defaultInterval = source.defaultInterval ?? schedulerDefaultInterval;
        const effectiveInterval = row?.interval ?? defaultInterval;
        return {
          name: source.name,
          description: source.description,
          configured: row !== undefined,
          enabled: isEffectivelyEnabled(source, row),
          interval: row?.interval ?? null,
          effectiveInterval,
          effectiveIntervalMs: parseInterval(effectiveInterval),
          defaultInterval,
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
