#!/usr/bin/env bun
/**
 * Delete cross-era duplicate facebook message rows.
 *
 * Facebook export eras disagree on a thread's first-message timestamp for a
 * handful of threads, so the same message can exist under two different
 * `msg:<convFirstTs>:` source_id prefixes — sometimes in two different
 * conversations (era-split thread twins, post-#544) and sometimes within
 * one (the original dual-import artifacts). A duplicate is a facebook
 * message row whose (source_account, type, sender_name, timestamp_ms,
 * content) exactly matches another row under a DIFFERENT source_id prefix:
 * a sender cannot send two identical messages in the same millisecond, so
 * cross-prefix matches are import artifacts, not coincidences. Same-prefix
 * matches (e.g. photo bursts sharing a timestamp, disambiguated by the
 * source_id's :idx suffix) are never touched.
 *
 * Keeps the copy whose conversation has the most message rows (the
 * full-history era; ties broken by lowest id), deletes the rest along with
 * their attachment rows (media files are content-hash shared and untouched;
 * pending registrations are re-derivable by the attachment recovery flow).
 *
 * Idempotent: a second run finds zero groups. Per-row FTS/event_people/
 * summary triggers stay live because the affected set is small.
 *
 * Usage:
 *   bun run src/scripts/dedupe-facebook-messages.ts --dry-run   # preview
 *   bun run src/scripts/dedupe-facebook-messages.ts             # apply
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";

interface DupeRow {
  id: number;
  title: string | null;
  conversation_id: string;
  keeper_conversation_id: string;
}

/**
 * Two passes with different second discriminators alongside (account, type,
 * timestamp_ms, content): `sender` catches twins across thread renames;
 * `title` catches twins whose sender label drifted between exports (account
 * renames, deleted-account anonymization). Both require a different
 * source_id prefix, so same-prefix photo bursts are never candidates.
 */
const KEY_VARIANTS = {
  sender: "m.source_account, m.type, m.sender, m.ts_ms, m.content_key",
  title: "m.source_account, m.type, m.title, m.ts_ms, m.content_key",
} as const;

export type DupeKeyVariant = keyof typeof KEY_VARIANTS;

function dupeCandidatesSql(variant: DupeKeyVariant): string {
  const key = KEY_VARIANTS[variant];
  return `
  WITH msgs AS (
    SELECT id, conversation_id, title, source_account, type,
           substr(source_id, 1, instr(substr(source_id, 5), ':') + 4) AS prefix,
           json_extract(raw_data, '$.sender_name') AS sender,
           json_extract(raw_data, '$.timestamp_ms') AS ts_ms,
           COALESCE(content, '') AS content_key
    FROM events
    WHERE source = 'facebook' AND type LIKE 'message%'
      AND conversation_id IS NOT NULL
      AND source_id LIKE 'msg:%'
  ),
  conv_sizes AS (
    SELECT conversation_id, COUNT(*) AS n FROM msgs GROUP BY conversation_id
  ),
  ranked AS (
    SELECT m.id, m.title, m.conversation_id, m.prefix,
           ROW_NUMBER() OVER (
             PARTITION BY ${key}
             ORDER BY cs.n DESC, m.id ASC
           ) AS rn,
           FIRST_VALUE(m.conversation_id) OVER (
             PARTITION BY ${key}
             ORDER BY cs.n DESC, m.id ASC
           ) AS keeper_conversation_id,
           FIRST_VALUE(m.prefix) OVER (
             PARTITION BY ${key}
             ORDER BY cs.n DESC, m.id ASC
           ) AS keeper_prefix
    FROM msgs m
    JOIN conv_sizes cs ON cs.conversation_id = m.conversation_id
  )
  SELECT id, title, conversation_id, keeper_conversation_id
  FROM ranked
  WHERE rn > 1 AND prefix != keeper_prefix
  ORDER BY id
`;
}

export function findDuplicateFacebookMessages(db: Database, variant: DupeKeyVariant): DupeRow[] {
  return db.prepare(dupeCandidatesSql(variant)).all() as DupeRow[];
}

export function dedupeFacebookMessages(
  db: Database,
  options: { dryRun?: boolean; silent?: boolean } = {}
): { deletedEvents: number; deletedAttachments: number } {
  const log = options.silent ? () => {} : console.log;

  const before = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'facebook' AND type LIKE 'message%'`)
    .get() as { n: number };
  log(`Facebook message rows: ${before.n.toLocaleString()}`);

  let deletedAttachments = 0;

  // Sequential passes: the title pass re-detects on the post-sender-pass
  // state, so a row is only ever deleted against a still-surviving keeper.
  for (const variant of Object.keys(KEY_VARIANTS) as DupeKeyVariant[]) {
    const dupes = findDuplicateFacebookMessages(db, variant);
    log(`\n[${variant} pass] duplicates to delete: ${dupes.length.toLocaleString()}`);

    const byTitle = new Map<string, number>();
    for (const d of dupes) {
      const key = d.title ?? "(no title)";
      byTitle.set(key, (byTitle.get(key) ?? 0) + 1);
    }
    for (const [title, n] of [...byTitle.entries()].sort((a, b) => b[1] - a[1])) {
      log(`  ${String(n).padStart(6)}  ${title}`);
    }

    if (dupes.length === 0) continue;

    const ids = dupes.map((d) => d.id);
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 500) chunks.push(ids.slice(i, i + 500));

    let attachmentCount = 0;
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => "?").join(",");
      attachmentCount += (
        db
          .prepare(`SELECT COUNT(*) AS n FROM attachments WHERE event_id IN (${placeholders})`)
          .get(...chunk) as { n: number }
      ).n;
    }
    log(`  attachment rows on deleted events: ${attachmentCount.toLocaleString()}`);

    if (options.dryRun) continue;

    db.exec("BEGIN");
    try {
      for (const chunk of chunks) {
        const placeholders = chunk.map(() => "?").join(",");
        // Explicit attachment cleanup: the schema declares ON DELETE CASCADE
        // but foreign_keys enforcement is connection-dependent, so don't rely
        // on it.
        db.prepare(`DELETE FROM attachments WHERE event_id IN (${placeholders})`).run(...chunk);
        db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).run(...chunk);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    deletedAttachments += attachmentCount;
  }

  if (options.dryRun) {
    log("\n(dry run — no changes applied; the title pass may find more once the sender pass has run)");
    return { deletedEvents: 0, deletedAttachments: 0 };
  }

  const after = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'facebook' AND type LIKE 'message%'`)
    .get() as { n: number };
  const residue =
    findDuplicateFacebookMessages(db, "sender").length +
    findDuplicateFacebookMessages(db, "title").length;
  log(`\nAfter: ${after.n.toLocaleString()} rows (deleted ${(before.n - after.n).toLocaleString()}); residual duplicate rows: ${residue}`);
  if (residue !== 0) {
    throw new Error(`Expected zero residual duplicates after apply, found ${residue}`);
  }

  return { deletedEvents: before.n - after.n, deletedAttachments };
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const db = getDb();
  initDb(db);

  console.log("============================================================");
  console.log("Dedupe facebook cross-era duplicate messages");
  console.log("============================================================");
  if (dryRun) console.log("*** DRY RUN — no changes will be made ***");

  dedupeFacebookMessages(db, { dryRun });
  db.close();
}
