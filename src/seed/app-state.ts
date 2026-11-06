import type { Database } from "bun:sqlite";
import { saveDaySummary } from "../db/app-state";
import { SYNC_SOURCES } from "../sync/sources";
import { upsertSyncSourcePatch } from "../sync/config";
import { parseInterval } from "../config/types";
import type { SeedContext, SeedSource } from "./context";
import { HOME_DIR } from "./persona";

/** Model id the seeded day summaries are cached under. */
const SUMMARY_MODEL = "google/gemini-3.1-flash-lite";

/** What a generator added, as measured by the runner. */
export interface GeneratorImport {
  events: number;
  /** Latest event timestamp the generator wrote. */
  newest: string | null;
}

/** Upkeep sources that run regardless of which data sources are seeded. */
const MAINTENANCE_SOURCES = ["thumbhash", "render-sweep", "backup-app-state", "backup"];

const INTERVALS: Readonly<Record<string, string>> = {
  discord: "15m",
  "google-messages": "15m",
  "spotify-friends": "15m",
  spotify: "30m",
  "claude-code": "30m",
  codex: "30m",
  t3code: "30m",
  thumbhash: "30m",
  "google-health": "6h",
  thriva: "1d",
  backup: "1d",
  "backup-app-state": "1d",
};

/**
 * Seeded from an export rather than through their sync, so sync history would
 * claim events the database doesn't contain (the GitHub API sync writes
 * different types than the export importer).
 */
const NO_SYNC_HISTORY = new Set(["github"]);

const FAILURES: Readonly<Record<string, string>> = {
  monzo: "Monzo API returned 401: access token expired; re-authenticate from Settings",
  trakt: "Trakt API returned 429; retry after 300s",
};

/** Exports that arrive as files through the inbox rather than a sync. */
const INBOX_EXPORTS: Readonly<Record<string, string>> = {
  facebook: "facebook-alexrivera.zip",
  instagram: "instagram-alexrivera.zip",
  "google-search": "takeout-search.zip",
  "google-youtube": "takeout-youtube.zip",
  "google-chrome": "takeout-chrome.zip",
  "google-keep": "takeout-keep.zip",
  "google-calendar": "takeout-calendar.zip",
  "google-location": "takeout-location-history.zip",
  "google-timeline": "Timeline.json",
  linkedin: "Basic_LinkedInDataExport.zip",
  reddit: "reddit-export.zip",
  amex: "amex-activity.csv",
  "sms-backup-restore": "sms-backup.xml",
  fitbit: "takeout-fitbit.zip",
  chatgpt: "chatgpt-export.zip",
  claude: "claude-export.zip",
};

/**
 * App-state rows that make /status, Settings, and the day summary look like a
 * running instance: per-source sync settings, a few days of sync history with
 * the occasional failure, scheduler state, processed inbox files, and cached
 * day summaries derived from each day's actual events.
 *
 * Sync sources are seeded disabled: their history is synthetic, and enabling
 * them would let `bun run service` pull a real account into the synthetic DB.
 */
export function seedAppState(
  ctx: SeedContext,
  db: Database,
  seeded: readonly SeedSource[],
  imports: ReadonlyMap<string, GeneratorImport>,
): void {
  const seededNames = new Set(seeded.map((source) => source.name));
  const syncNames = SYNC_SOURCES.map((source) => source.name).filter(
    (name) => (seededNames.has(name) && !NO_SYNC_HISTORY.has(name)) || MAINTENANCE_SOURCES.includes(name),
  );
  // The last run is the anchor day's evening, or now when that is still ahead
  // (the default anchor is today), so /status never reports runs from the future.
  const now = Math.min(ctx.localDate(ctx.anchorDate, 21, 0).getTime(), Date.now());

  const insertLog = db.prepare(`
    INSERT INTO sync_log (source, started_at, finished_at, success, skipped, events_added, events_updated, error, duration_ms)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
  `);
  const insertScheduler = db.prepare(`
    INSERT INTO scheduler_state (source, last_run_at, next_run_at, interval_ms, enabled)
    VALUES (?, ?, NULL, ?, 0)
  `);

  db.transaction(() => {
    for (const name of syncNames) {
      // One stream per source, so this history doesn't depend on the order of SYNC_SOURCES.
      const rng = ctx.rng(`app-state:${name}`);
      const interval = INTERVALS[name] ?? "1h";
      const intervalMs = parseInterval(interval);
      upsertSyncSourcePatch(name, { enabled: false, interval }, db);

      // Up to three days of history, capped at 72 runs; oldest first so ids follow time.
      const runs = Math.min(72, Math.ceil((3 * 86_400_000) / intervalMs));
      const failureRun = Math.min(4, runs - 1);
      let lastRun = now;
      for (let i = runs - 1; i >= 0; i--) {
        const started = now - i * intervalMs - rng.int(0, 90) * 1000;
        const durationMs = rng.int(400, name.startsWith("backup") ? 45_000 : 6_000);
        const failure = i === failureRun ? FAILURES[name] : undefined;
        const maintenance = MAINTENANCE_SOURCES.includes(name);
        insertLog.run(
          name,
          sqliteTimestamp(started),
          sqliteTimestamp(started + durationMs),
          failure ? 0 : 1,
          failure || maintenance ? 0 : rng.poisson(intervalMs >= 86_400_000 ? 20 : 3),
          failure || maintenance ? 0 : rng.poisson(0.5),
          failure ?? null,
          durationMs,
        );
        lastRun = started + durationMs;
      }
      insertScheduler.run(name, sqliteTimestamp(lastRun), intervalMs);
    }

    seedProcessedFiles(ctx, db, seeded, imports, now);
    seedDaySummaries(ctx, db);
  })();
}

/** One inbox file per export-based generator, processed shortly after its newest event. */
function seedProcessedFiles(
  ctx: SeedContext,
  db: Database,
  seeded: readonly SeedSource[],
  imports: ReadonlyMap<string, GeneratorImport>,
  now: number,
): void {
  const insert = db.prepare(`
    INSERT INTO processed_files (source, file_path, file_hash, file_size, processed_at, import_batch, detected_type, events_added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const generator of seeded) {
    const file = INBOX_EXPORTS[generator.name];
    if (!file) continue;
    const rng = ctx.rng(`app-state:inbox:${generator.name}`);
    const imported = imports.get(generator.name);
    if (!imported?.newest) throw new Error(`No import recorded for inbox export ${generator.name}`);
    // Inbox history is keyed by the events.source the import writes.
    const [source] = Object.keys(generator.produces);
    if (!source || Object.keys(generator.produces).length !== 1) {
      throw new Error(`Inbox export ${generator.name} must produce exactly one events source`);
    }
    const processedAt = Math.min(Date.parse(imported.newest) + rng.int(1, 72) * 3_600_000, now);
    insert.run(
      source,
      `${HOME_DIR}/timeline-inbox/${source}/${file}`,
      rng.hex(64),
      rng.int(200_000, 400_000_000),
      sqliteTimestamp(processedAt),
      `${source}-seed`,
      source,
      imported.events,
    );
  }
}

interface DayRollup {
  source: string;
  type: string;
  n: number;
}

/**
 * Cached summaries for the most recent fortnight, written from each day's real
 * seeded events so they agree with the day view.
 */
function seedDaySummaries(ctx: SeedContext, db: Database): void {
  const rollup = ctx.db.prepare(`
    SELECT source, type, COUNT(*) AS n FROM events
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY source, type ORDER BY n DESC
  `);
  const topTitle = ctx.db.prepare(`
    SELECT title, COUNT(*) AS n FROM events
    WHERE source = ? AND timestamp >= ? AND timestamp < ? AND title IS NOT NULL
    GROUP BY title ORDER BY n DESC, title LIMIT 1
  `);

  for (const day of ctx.recentDays(14)) {
    const from = ctx.localIso(day.date, 0);
    const next = ctx.days[day.index + 1];
    const to = next ? ctx.localIso(next.date, 0) : ctx.localIso(day.date, 24);
    const rows = rollup.all(from, to) as DayRollup[];
    const total = rows.reduce((sum, row) => sum + row.n, 0);
    if (total === 0) continue;

    const sum = (predicate: (row: DayRollup) => boolean) =>
      rows.filter(predicate).reduce((acc, row) => acc + row.n, 0);
    const isCoding = (row: DayRollup) => /:message:(user|assistant)$|^code:session$/.test(row.type);
    const messages = sum((row) => /message|^sms|^mms|^rcs/.test(row.type) && !isCoding(row));
    const listens = sum((row) => row.type.startsWith("listen:") && !row.type.endsWith(":friend"));
    const coding = sum(isCoding);
    const visits = sum((row) => row.type.endsWith("visit"));
    const title = (source: string) => (topTitle.get(source, from, to) as { title: string } | null)?.title;

    const lines = [`## ${day.isWeekend ? "A weekend" : "A weekday"} in Seattle`, ""];
    if (messages > 0) {
      const thread = title("discord") ?? title("google-messages");
      lines.push(`- **Conversations:** ${messages} messages${thread ? `, busiest in “${thread}”` : ""}.`);
    }
    if (listens > 0) {
      const track = title("spotify");
      lines.push(`- **Music:** ${listens} plays${track ? `, with “${track}” on repeat` : ""}.`);
    }
    if (coding > 0) lines.push(`- **Coding:** ${coding} coding-agent messages and sessions across Alex's projects.`);
    if (visits > 0) lines.push(`- **Out and about:** ${visits} place visits.`);
    lines.push("", `${total} events in total across ${new Set(rows.map((row) => row.source)).size} sources.`);

    saveDaySummary(db, {
      date: day.date,
      model: SUMMARY_MODEL,
      summary: lines.join("\n"),
      token_count: total * 18,
      event_count: total,
      metadata: null,
    });
  }
}

/** `YYYY-MM-DD HH:MM:SS` UTC, the format SQLite's datetime('now') writes. */
function sqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
