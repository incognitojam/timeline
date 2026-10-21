#!/usr/bin/env bun
/**
 * Backfill Claude Code Project Names
 *
 * Corrects `title` and the `project:` tag on existing `claude-code` events.
 *
 * Older imports derived the project name by splitting the dash-encoded
 * `~/.claude/projects/<dir>` directory name on `-` and keeping the last
 * segment, truncating multi-segment directory names (e.g. `example-service-api`
 * -> `api`, `example-discord-client` -> `client`, `example-builder` -> `builder`).
 * The real name is the basename of the session's launch directory, recorded
 * as `cwd` on each message (see `claudeCodeProjectName` in
 * ../parsers/claude-code).
 *
 * This recomputes the name per session from the EARLIEST message's cwd — the
 * launch dir, since the user may `cd` into a subdirectory mid-session — and
 * rewrites every row whose title prefix or `project:` tag is stale. Idempotent:
 * rows already carrying the correct name are left untouched.
 *
 * Limitation: unlike the parser, this runs against the DB only and has no access
 * to the on-disk `~/.claude/projects/<dir>` name, so it can't round-trip a cwd
 * against the project dir to identify the launch directory. It uses the earliest
 * recorded cwd instead. This differs only for the rare session that *starts* in
 * a container dir before descending into the real project (the earliest cwd is
 * then the container, not the launch dir); such sessions get the container name
 * here, while the parser names them correctly on import. They can be corrected
 * with a targeted UPDATE if needed.
 *
 * Usage:
 *   bun run src/scripts/backfill-claude-code-project-names.ts [--dry-run] [--verbose]
 */

import type { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import { projectNameFromLaunchCwd } from "../parsers/claude-code";

export interface BackfillOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export interface BackfillStats {
  sessions: number; // sessions with a resolved launch-cwd project name
  sessionsSkipped: number; // sessions with no cwd recorded on any message
  rowsUpdated: number;
  rowsUnchanged: number;
}

interface LaunchRow {
  session_id: string;
  cwd: string | null;
}

interface EventRow {
  id: number;
  session_id: string;
  title: string;
  tags: string | null;
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string")
      : [];
  } catch {
    return [];
  }
}

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// Title is `<project>` or `<project> (<slug>)`. Split off the project prefix so
// we can swap it while preserving the slug suffix. Mirrors the title built in
// the parser (`${projectName} (${sessionSlug})`).
function splitTitle(title: string): { prefix: string; suffix: string } {
  const idx = title.indexOf(" (");
  return idx < 0
    ? { prefix: title, suffix: "" }
    : { prefix: title.slice(0, idx), suffix: title.slice(idx) };
}

export function backfillClaudeCodeProjectNames(
  db: Database,
  options: BackfillOptions = {}
): BackfillStats {
  const dryRun = options.dryRun ?? false;
  const verbose = options.verbose ?? false;

  // Launch cwd per session: the earliest message that recorded a cwd. Keyed on
  // raw_data.session_id (always written by the parser) rather than
  // conversation_id (added later, so NULL on older rows). Filtering out null
  // cwds *before* ranking means rn = 1 is the first message that actually
  // carried one (the launch dir), even if a leading row omitted it.
  const launchRows = db
    .prepare(`
      WITH ranked AS (
        SELECT
          json_extract(raw_data, '$.session_id') AS session_id,
          json_extract(raw_data, '$.cwd') AS cwd,
          ROW_NUMBER() OVER (
            PARTITION BY json_extract(raw_data, '$.session_id')
            ORDER BY timestamp ASC, id ASC
          ) AS rn
        FROM events
        WHERE source = 'claude-code'
          AND json_extract(raw_data, '$.session_id') IS NOT NULL
          AND json_extract(raw_data, '$.cwd') IS NOT NULL
      )
      SELECT session_id, cwd FROM ranked WHERE rn = 1
    `)
    .all() as LaunchRow[];

  const launchName = new Map<string, string>();
  for (const row of launchRows) {
    if (!row.cwd) continue;
    const name = projectNameFromLaunchCwd(row.cwd);
    if (name) launchName.set(row.session_id, name);
  }

  const events = db
    .prepare(`
      SELECT
        id,
        json_extract(raw_data, '$.session_id') AS session_id,
        title,
        tags
      FROM events
      WHERE source = 'claude-code'
        AND json_extract(raw_data, '$.session_id') IS NOT NULL
        AND title IS NOT NULL
      ORDER BY id
    `)
    .all() as EventRow[];

  const update = db.prepare("UPDATE events SET title = ?, tags = ? WHERE id = ?");

  const stats: BackfillStats = {
    sessions: launchName.size,
    sessionsSkipped: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
  };
  const skippedSessions = new Set<string>();

  const run = db.transaction(() => {
    for (const ev of events) {
      const newName = launchName.get(ev.session_id);
      if (!newName) {
        skippedSessions.add(ev.session_id);
        continue;
      }

      const { prefix, suffix } = splitTitle(ev.title);
      const newTitle = newName + suffix;

      const oldTags = parseTags(ev.tags);
      const oldTag = `project:${prefix}`;
      const newTag = `project:${newName}`;
      const newTags = oldTags.map((t) => (t === oldTag ? newTag : t));

      if (newTitle === ev.title && tagsEqual(newTags, oldTags)) {
        stats.rowsUnchanged++;
        continue;
      }

      if (verbose) {
        console.log(`  #${ev.id}: "${ev.title}" -> "${newTitle}"`);
      }
      if (!dryRun) {
        update.run(newTitle, newTags.length ? JSON.stringify(newTags) : null, ev.id);
      }
      stats.rowsUpdated++;

      if (stats.rowsUpdated % 1000 === 0) {
        console.log(`  Progress: ${stats.rowsUpdated} rows rewritten`);
      }
    }
  });
  run();

  stats.sessionsSkipped = skippedSessions.size;
  return stats;
}

function parseArgs(): BackfillOptions {
  const args = process.argv.slice(2);
  const options: BackfillOptions = {};
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verbose" || arg === "-v") options.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run src/scripts/backfill-claude-code-project-names.ts [--dry-run] [--verbose]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}

if (import.meta.main) {
  const db = getDb();
  initDb(db);
  const options = parseArgs();

  console.log(
    `\nBackfilling claude-code project names${options.dryRun ? " (dry run)" : ""}\n`
  );
  const stats = backfillClaudeCodeProjectNames(db, options);

  console.log(`\nSessions resolved (launch cwd known): ${stats.sessions}`);
  console.log(`Sessions skipped (no cwd recorded):   ${stats.sessionsSkipped}`);
  console.log(`Rows updated:   ${stats.rowsUpdated}`);
  console.log(`Rows unchanged: ${stats.rowsUnchanged}`);
  if (options.dryRun) {
    console.log("\nDry run — no rows were modified. Re-run without --dry-run to apply.");
  }

  db.close();
}
