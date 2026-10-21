/**
 * Discord Custom Emoji Downloader
 *
 * Mirrors the structure of attachment-downloader.ts but operates on the
 * `discord_emojis` table — one row per unique emoji_id, globally shared.
 *
 * Two-phase API:
 *   - upsertEmojiRefs(db, refs)            — synchronous, no network. Inserts
 *                                            'pending' rows so refs are durably
 *                                            recorded even if a sync aborts.
 *   - downloadPendingEmojis(db, signal)    — fetches every 'pending' row from
 *                                            cdn.discordapp.com and stores it.
 */

import type { Database } from "bun:sqlite";
import { storeFile } from "../../media/storage";
import type { EmojiRef } from "./emoji-extractor";

const MAX_CONCURRENT_DOWNLOADS = 2;
const CDN_BASE = "https://cdn.discordapp.com/emojis";

interface PendingRow {
  emoji_id: string;
  name: string;
  animated: number | null;
}

function refToColumn(ref: EmojiRef["animated"]): number | null {
  if (ref === true) return 1;
  if (ref === false) return 0;
  return null;
}

/**
 * Insert pending rows for any emoji we don't already know about, and refresh
 * `name`/`last_seen`/`animated` for ones we do. Cheap; safe to call per batch.
 *
 * `animated` precedence on conflict: known-animated (1) > known-static (0) >
 * unknown (NULL). Once we've seen `<a:` evidence, we never downgrade.
 */
export function upsertEmojiRefs(db: Database, refs: EmojiRef[]): void {
  if (refs.length === 0) return;

  const stmt = db.prepare(`
    INSERT INTO discord_emojis (emoji_id, name, animated, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT(emoji_id) DO UPDATE SET
      name = excluded.name,
      animated = CASE
        WHEN excluded.animated = 1 OR discord_emojis.animated = 1 THEN 1
        WHEN excluded.animated = 0 OR discord_emojis.animated = 0 THEN 0
        ELSE NULL
      END,
      last_seen = datetime('now')
  `);

  const tx = db.transaction((rows: EmojiRef[]) => {
    for (const r of rows) {
      stmt.run(r.id, r.name, refToColumn(r.animated));
    }
  });
  tx(refs);
}

/**
 * Fetch a single emoji from the CDN. The `animatedHint` is tri-state:
 *   true  → known animated, fetch only `.gif`
 *   false → known static, fetch only `.png`
 *   null  → unknown, gif-first probe (PNG-first would silently freeze
 *           animated emoji into a single-frame PNG)
 * Returns null when every attempted extension 404/415s (caller tombstones).
 */
async function fetchEmojiBytes(
  emojiId: string,
  animatedHint: boolean | null,
  signal?: AbortSignal,
): Promise<{ content: Buffer; ext: "gif" | "png"; animated: boolean } | null> {
  let tryOrder: Array<"gif" | "png">;
  if (animatedHint === true) tryOrder = ["gif"];
  else if (animatedHint === false) tryOrder = ["png"];
  else tryOrder = ["gif", "png"];

  let lastStatus = 0;
  for (const ext of tryOrder) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const res = await fetch(`${CDN_BASE}/${emojiId}.${ext}`, { signal });
    if (res.ok) {
      const content = Buffer.from(await res.arrayBuffer());
      return { content, ext, animated: ext === "gif" };
    }
    lastStatus = res.status;
    if (res.status !== 404 && res.status !== 415) {
      throw new Error(`HTTP ${res.status} downloading emoji ${emojiId}.${ext}`);
    }
  }
  // Every tried extension returned 404/415 → tombstone.
  if (lastStatus === 404 || lastStatus === 415) return null;
  return null;
}

/**
 * Download a single emoji and persist the result. Returns 'stored',
 * 'tombstoned', or throws (transient — leaves the row 'pending' for retry).
 */
export async function downloadEmoji(
  db: Database,
  row: PendingRow,
  signal?: AbortSignal,
): Promise<"stored" | "tombstoned"> {
  const hint: boolean | null =
    row.animated === 1 ? true : row.animated === 0 ? false : null;
  const result = await fetchEmojiBytes(row.emoji_id, hint, signal);

  if (!result) {
    db.prepare(`
      UPDATE discord_emojis
      SET status = 'tombstoned', fetched_at = datetime('now'), last_seen = datetime('now')
      WHERE emoji_id = ?
    `).run(row.emoji_id);
    return "tombstoned";
  }

  const stored = await storeFile({
    source: "discord",
    relativePath: `emoji/${row.emoji_id}.${result.ext}`,
    content: result.content,
  });

  db.prepare(`
    UPDATE discord_emojis
    SET status = 'stored',
        animated = ?,
        ext = ?,
        content_hash = ?,
        storage_path = ?,
        file_size = ?,
        fetched_at = datetime('now'),
        last_seen = datetime('now')
    WHERE emoji_id = ?
  `).run(
    result.animated ? 1 : 0,
    result.ext,
    stored.hash,
    stored.storagePath,
    stored.fileSize,
    row.emoji_id,
  );

  return "stored";
}

export interface DownloadResult {
  stored: number;
  tombstoned: number;
  failed: number;
}

/**
 * Download every 'pending' emoji in the table. Concurrency=2 mirrors the
 * attachment downloader. Idempotent — safe to re-run; already-stored and
 * already-tombstoned rows are skipped by the WHERE clause.
 */
export async function downloadPendingEmojis(
  db: Database,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const pending = db
    .prepare(`SELECT emoji_id, name, animated FROM discord_emojis WHERE status = 'pending' ORDER BY emoji_id`)
    .all() as PendingRow[];

  const result: DownloadResult = { stored: 0, tombstoned: 0, failed: 0 };
  if (pending.length === 0) return result;

  for (let i = 0; i < pending.length; i += MAX_CONCURRENT_DOWNLOADS) {
    if (signal?.aborted) break;
    const batch = pending.slice(i, i + MAX_CONCURRENT_DOWNLOADS);
    const settled = await Promise.allSettled(batch.map((row) => downloadEmoji(db, row, signal)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "fulfilled") {
        if (s.value === "stored") result.stored++;
        else result.tombstoned++;
      } else {
        if (s.reason instanceof DOMException && s.reason.name === "AbortError") throw s.reason;
        result.failed++;
        console.error(`[discord] Emoji download failed for ${batch[j].emoji_id}:`, s.reason);
      }
    }
  }

  return result;
}

/**
 * Fetch a single emoji on demand (proxy-on-miss path for the API). Inserts a
 * pending row first so concurrent requests dedupe at the DB level, then
 * downloads. Returns the storage row on success, null on tombstone.
 */
export async function fetchEmojiOnDemand(
  db: Database,
  emojiId: string,
  signal?: AbortSignal,
): Promise<{ status: "stored" | "tombstoned" }> {
  // Ensure a pending row exists so re-entrant callers see consistent state.
  // animated=NULL → unknown → downloader probes gif-first.
  db.prepare(`
    INSERT INTO discord_emojis (emoji_id, name, animated, status)
    VALUES (?, ?, NULL, 'pending')
    ON CONFLICT(emoji_id) DO NOTHING
  `).run(emojiId, emojiId); // name = id when caller doesn't know it

  // Re-read after the upsert. Short-circuit terminal states so this helper is
  // safe to call regardless of caller-side guards — closes the window where a
  // concurrent request finished the download between the API's status check
  // and the call here.
  const row = db
    .prepare(`SELECT emoji_id, name, animated, status FROM discord_emojis WHERE emoji_id = ?`)
    .get(emojiId) as (PendingRow & { status: "pending" | "stored" | "tombstoned" }) | null;
  if (!row) return { status: "tombstoned" };
  if (row.status === "stored") return { status: "stored" };
  if (row.status === "tombstoned") return { status: "tombstoned" };

  const status = await downloadEmoji(db, row, signal);
  return { status };
}
