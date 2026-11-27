/**
 * Storing fetched Discord messages, shared by the full sync and the DM pass so
 * both store a message the same way: the event row, its first reaction
 * observation and reactors, its attachments, its custom-emoji refs, and the
 * channel cursor.
 */

import { type UpsertIdentityOptions, upsertIdentities } from "../../db/identities";
import { onImportComplete } from "../../db/import-hooks";
import { downloadAndStoreAttachments } from "./attachment-downloader";
import type { DiscordClient, NormalizedMessage } from "./client";
import { upsertEmojiRefs } from "./emoji-downloader";
import { extractEmojiRefs } from "./emoji-extractor";
import { type ChannelContext, convertMessage, getMessageAttachments } from "./event-converter";
import { reconcileDiscordMessage } from "./message-reconciliation";
import type { DiscordApiSyncState } from "./sync";
import { buildEmojiCountMap } from "./tier-rescan";

type Db = import("bun:sqlite").Database;

// Reaction authors (who reacted, not just the emoji + count the message fetch
// returns) are captured at first sync only for messages younger than this gate.
// Rationale: messages older than the 24h tier never enter a reaction rescan
// (their band has already aged past every tier), so a first backfill of a
// historical channel would otherwise fire an author fetch per old reacted
// message — thousands of requests for reactions long since settled. Gating on
// age keeps initial author capture to the freshly-posted band, which is also
// where late-deleted reactions would otherwise cost us the author list.
const INITIAL_AUTHOR_CAPTURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface MessageStore {
  /**
   * Store one channel's messages, oldest first. The channel's cursor moves
   * past a message only once that message is stored, so a batch cut short by
   * an error or an abort leaves the cursor at the last stored message.
   */
  storeBatch(messages: NormalizedMessage[], channelCtx: ChannelContext): Promise<void>;
  /** Write the identities collected so far. Safe to call repeatedly. */
  flushIdentities(): void;
  readonly totals: {
    added: number;
    attachments: { stored: number; failed: number };
    /** Already-stored messages whose re-fetch showed an edit. */
    edited: number;
    tombstonesCleared: number;
  };
}

export function createMessageStore(args: {
  db: Db;
  client: DiscordClient;
  userId: string;
  importBatch: string;
  state: DiscordApiSyncState;
  signal?: AbortSignal;
  verbose: boolean;
}): MessageStore {
  const { db, client, userId, importBatch, state, signal } = args;
  const totals: MessageStore["totals"] = { added: 0, attachments: { stored: 0, failed: 0 }, edited: 0, tombstonesCleared: 0 };
  const identities: UpsertIdentityOptions[] = [];

  let statements: ReturnType<typeof prepareStatements> | null = null;

  const storeBatch = async (messages: NormalizedMessage[], channelCtx: ChannelContext) => {
    const { insert, insertObservation, updateReactions } = (statements ??= prepareStatements(db));
    for (const msg of messages) {
      if (signal?.aborted) return;

      const { event, identities: messageIdentities } = convertMessage(msg, channelCtx, userId, importBatch);
      identities.push(...messageIdentities);

      const result = insert.run(
        event.source,
        event.sourceId,
        event.sourceAccount,
        event.type,
        event.timestamp,
        event.title,
        event.content,
        JSON.stringify(event.people),
        event.tags,
        JSON.stringify(event.rawData),
        event.importBatch,
        event.conversationId
      );

      if (result.changes > 0) {
        totals.added++;
        const eventId = Number(result.lastInsertRowid);

        // Record initial reaction observation if the message had any
        // reactions at first sync. Provides a baseline for measuring drift
        // captured by later tier re-fetches. The observation records counts
        // only — author capture below is separate.
        if (msg.reactions.length > 0) {
          const nowMs = Date.now();
          const ageMs = nowMs - Date.parse(msg.timestamp);
          const totalCount = msg.reactions.reduce((s, r) => s + r.count, 0);
          insertObservation.run(
            eventId,
            "initial",
            new Date(nowMs).toISOString(),
            ageMs,
            totalCount,
            JSON.stringify(buildEmojiCountMap(msg.reactions)),
          );

          // Capture *who* reacted at first sync for freshly-posted messages
          // (the message fetch returns only emoji + count). Gated on age so
          // a historical backfill doesn't fire an author fetch per old
          // reacted message — see INITIAL_AUTHOR_CAPTURE_MAX_AGE_MS. Runs
          // after the INSERT OR IGNORE so a duplicate (no-op) message —
          // e.g. a sparse-context overlap — never wastes an author fetch.
          if (
            !signal?.aborted &&
            ageMs < INITIAL_AUTHOR_CAPTURE_MAX_AGE_MS
          ) {
            // Isolate hard failures like the attachment path does: author
            // enrichment is best-effort, and one bad fetch must not abort
            // the rest of the sync run. The counts are already stored; a
            // count change at the 1h/6h/24h tiers re-attempts the capture.
            try {
              const enriched = await client.fetchAllReactionUsers(
                channelCtx.id,
                msg.id,
                msg.reactions,
              );
              updateReactions.run(JSON.stringify(enriched), msg.id, userId);
            } catch (err) {
              if (err instanceof DOMException && err.name === "AbortError") throw err;
              console.warn(
                `[discord] initial author capture failed for ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        // Discord forwards keep the original files inside message_snapshots,
        // while the forwarding wrapper's attachment array stays empty.
        const messageAttachments = getMessageAttachments(msg);
        if (messageAttachments.length > 0) {
          const attResult = await downloadAndStoreAttachments(
            db,
            eventId,
            channelCtx.id,
            messageAttachments,
            signal
          );
          totals.attachments.stored += attResult.stored;
          totals.attachments.failed += attResult.failed;
        }

        // Cheap: record any custom-emoji refs as 'pending' rows so we can
        // download them in a single deduped pass at the end of the sync.
        const emojiRefs = extractEmojiRefs(event.rawData);
        if (emojiRefs.length > 0) upsertEmojiRefs(db, emojiRefs);
      } else {
        // Sparse context and overlapping discovery paths often re-fetch an
        // already indexed message. Reconcile those observations for free.
        const reconciled = reconcileDiscordMessage(db, msg, userId);
        if (reconciled.edited) totals.edited++;
        if (reconciled.tombstoneCleared) totals.tombstonesCleared++;
      }

      // Update cursor
      const existing = state.channelCursors[channelCtx.id];
      if (!existing || BigInt(msg.id) > BigInt(existing)) {
        state.channelCursors[channelCtx.id] = msg.id;
      }
    }
  };

  // Safe to call multiple times — upsertIdentities uses ON CONFLICT UPDATE.
  const flushIdentities = () => {
    if (identities.length === 0) return;
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of identities) {
      uniqueIdentities.set(id.platformId, id);
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    if (args.verbose) console.log(`[discord] Flushed ${uniqueIdentities.size} identities`);
    identities.length = 0;
  };

  return { storeBatch, flushIdentities, totals };
}

function prepareStatements(db: Db) {
  return {
    insert: db.prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, people, tags, raw_data, import_batch, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertObservation: db.prepare(
      `INSERT OR REPLACE INTO discord_reaction_observations
         (event_id, tier, observed_at, age_ms, total_count, emoji_counts)
       VALUES (?, ?, ?, ?, ?, json(?))`,
    ),
    // Same shape as tier-rescan's updateReactions: writes the reactions
    // array (now carrying `users`) back into raw_data.$.reactions.
    updateReactions: db.prepare(
      "UPDATE events SET raw_data = json_set(raw_data, '$.reactions', json(?)) WHERE source = 'discord' AND source_id = ? AND source_account = ?",
    ),
  };
}

/**
 * Finish a run: write identities, run import hooks, save state, close the
 * database. Called on success and error paths alike, so the cursors saved are
 * only as far as the store has actually stored.
 */
export function finishMessageStore(db: Db, store: MessageStore, saveState: () => void): void {
  try {
    store.flushIdentities();

    if (store.totals.added > 0) {
      onImportComplete(db);
    }

    saveState();
  } finally {
    db.close();
  }
}
