import type { Database } from "bun:sqlite";
import { MAX_TIMEOUT_DELAY_MS } from "../../config/types";
import { getDb, initDb } from "../../db/schema";
import { getRegisteredRenderers, type RendererRegistration } from "../../render";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

export const DEFAULT_RENDER_SWEEP_TIME_BUDGET_MS = 60_000;
const RENDER_SWEEP_BATCH_SIZE = 500;

export interface RenderSweepSettings {
  dryRun: boolean;
  timeBudgetMs: number;
}

interface RenderedEventRow {
  id: number;
  source: string;
  title: string | null;
  content: string | null;
  raw_data: string;
}

interface RenderSweepStateRow {
  version: number;
  last_event_id: number;
}

interface SourceProgress {
  cursor: number;
  watermark: number;
  needsStateWrite: boolean;
}

export interface RenderSweepStats {
  examined: number;
  changed: number;
  unchanged: number;
  failed: number;
  invalidRawData: number;
  nullTitle: number;
  remaining: number;
  caughtUp: boolean;
  stoppedReason?: "time-budget" | "aborted";
}

export function parseRenderSweepSettings(config?: Record<string, unknown>): RenderSweepSettings | string {
  const dryRun = config?.dry_run ?? false;
  if (typeof dryRun !== "boolean") return "invalid dry_run setting";

  const timeBudgetMs = config?.time_budget_ms ?? DEFAULT_RENDER_SWEEP_TIME_BUDGET_MS;
  if (
    typeof timeBudgetMs !== "number" ||
    !Number.isInteger(timeBudgetMs) ||
    timeBudgetMs < 1 ||
    timeBudgetMs > MAX_TIMEOUT_DELAY_MS
  ) {
    return "invalid time_budget_ms setting";
  }

  return { dryRun, timeBudgetMs };
}

function parseRawData(rawData: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawData);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function selectEvents(db: Database, source: string, afterId: number): RenderedEventRow[] {
  return db.query<RenderedEventRow, [string, number]>(`
    SELECT id, source, title, content, raw_data
    FROM events
    WHERE source = ? AND id > ?
    ORDER BY id
    LIMIT ${RENDER_SWEEP_BATCH_SIZE}
  `).all(source, afterId);
}

function countRemainingEvents(db: Database, source: string, afterId: number): number {
  const row = db.query<{ count: number }, [string, number]>(`
    SELECT COUNT(*) AS count
    FROM events
    WHERE source = ? AND id > ?
  `).get(source, afterId);
  if (!row) throw new Error(`Failed to count remaining ${source} events`);
  return row.count;
}

function loadSourceProgress(
  db: Database,
  source: string,
  version: number,
): SourceProgress {
  const state = db.query<RenderSweepStateRow, [string]>(`
    SELECT version, last_event_id
    FROM render_sweep_state
    WHERE source = ?
  `).get(source);
  if (!state || state.version !== version) {
    return { cursor: 0, watermark: 0, needsStateWrite: true };
  }
  return {
    cursor: state.last_event_id,
    watermark: state.last_event_id,
    needsStateWrite: false,
  };
}

function renderedTextMatches(
  stored: string | null | undefined,
  rendered: string | null | undefined,
): boolean {
  return (stored ?? "") === (rendered ?? "");
}

export function sweepRenderedEvents(
  db: Database,
  settings: RenderSweepSettings,
  options: {
    signal?: AbortSignal;
    now?: () => number;
    renderers?: ReadonlyMap<string, RendererRegistration>;
  } = {},
): RenderSweepStats {
  const renderers = options.renderers ?? getRegisteredRenderers();
  const now = options.now ?? Date.now;
  const deadline = now() + settings.timeBudgetMs;
  const progressBySource = new Map<string, SourceProgress>();
  const stats: RenderSweepStats = {
    examined: 0,
    changed: 0,
    unchanged: 0,
    failed: 0,
    invalidRawData: 0,
    nullTitle: 0,
    remaining: 0,
    caughtUp: false,
  };
  const updateRenderedText = db.prepare("UPDATE events SET title = ?, content = ? WHERE id = ?");
  const saveWatermark = db.prepare(`
    INSERT INTO render_sweep_state (source, version, last_event_id, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(source) DO UPDATE SET
      version = excluded.version,
      last_event_id = excluded.last_event_id,
      updated_at = excluded.updated_at
  `);

  const stopReason = (): "time-budget" | "aborted" | undefined => {
    if (options.signal?.aborted) return "aborted";
    if (now() >= deadline) return "time-budget";
    return undefined;
  };

  const sources = [...renderers].map(([source, registration]) => ({
    source,
    registration,
    progress: loadSourceProgress(db, source, registration.version),
  }));
  for (const { source, progress } of sources) {
    progressBySource.set(source, progress);
  }

  while (sources.length > 0 && !stats.stoppedReason) {
    for (let index = 0; index < sources.length; index++) {
      const { source, registration, progress } = sources[index];
      const reason = stopReason();
      if (reason) {
        stats.stoppedReason = reason;
        break;
      }
      if (!settings.dryRun && progress.needsStateWrite) {
        saveWatermark.run(source, registration.version, 0);
        progress.needsStateWrite = false;
      }

      const rows = selectEvents(db, source, progress.cursor);
      if (rows.length === 0) {
        sources.splice(index, 1);
        index--;
        continue;
      }

      let processed = 0;
      const processBatch = () => {
        for (const row of rows) {
          const rowStopReason = stopReason();
          if (rowStopReason) {
            stats.stoppedReason = rowStopReason;
            break;
          }

          processed++;
          stats.examined++;
          const rawData = parseRawData(row.raw_data);
          if (!rawData) {
            stats.failed++;
            stats.invalidRawData++;
            continue;
          }

          const rendered = registration.render(rawData);
          if (rendered.title === null) {
            stats.failed++;
            stats.nullTitle++;
            continue;
          }

          if (
            renderedTextMatches(row.title, rendered.title) &&
            renderedTextMatches(row.content, rendered.content)
          ) {
            stats.unchanged++;
            continue;
          }

          stats.changed++;
          if (!settings.dryRun) {
            updateRenderedText.run(rendered.title, rendered.content, row.id);
          }
        }

        if (processed > 0 && !settings.dryRun) {
          progress.cursor = rows[processed - 1].id;
          progress.watermark = progress.cursor;
          progress.needsStateWrite = false;
          saveWatermark.run(source, registration.version, progress.cursor);
        }
      };

      if (settings.dryRun) {
        processBatch();
      } else {
        db.transaction(processBatch)();
      }

      if (processed === 0 || stats.stoppedReason) break;
      progress.cursor = rows[processed - 1].id;
    }
  }

  for (const [source, registration] of renderers) {
    const progress = progressBySource.get(source) ?? loadSourceProgress(db, source, registration.version);
    stats.remaining += countRemainingEvents(db, source, progress.watermark);
  }
  stats.caughtUp = stats.remaining === 0;
  return stats;
}

export const renderSweepSyncSource: SyncSource = {
  name: "render-sweep",
  description: "Re-render event text from stored source data",
  enabled: true,
  configSchema: [
    {
      key: "dry_run",
      type: "boolean",
      label: "Dry run",
      description: "Report rendered text changes without writing them",
      default: false,
    },
    {
      key: "time_budget_ms",
      type: "number",
      label: "Time budget",
      description: "Maximum run time in milliseconds",
      integer: true,
      min: 1,
      max: MAX_TIMEOUT_DELAY_MS,
      default: DEFAULT_RENDER_SWEEP_TIME_BUDGET_MS,
    },
  ],

  async canSync(config): Promise<string | null> {
    const settings = parseRenderSweepSettings(config);
    return typeof settings === "string" ? settings : null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startedAt = Date.now();
    const settings = parseRenderSweepSettings(options.config.sources["render-sweep"]);
    if (typeof settings === "string") {
      return {
        source: "render-sweep",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: settings,
        durationMs: 0,
      };
    }

    const db = getDb();
    try {
      initDb(db);
      const stats = sweepRenderedEvents(db, settings, { signal: options.signal });
      return {
        source: "render-sweep",
        success: true,
        eventsAdded: 0,
        eventsUpdated: stats.changed,
        durationMs: Date.now() - startedAt,
        metadata: { dryRun: settings.dryRun, ...stats },
      };
    } catch (error) {
      return {
        source: "render-sweep",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      db.close();
    }
  },
};
