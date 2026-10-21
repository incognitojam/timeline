/**
 * Discord reaction re-fetch tiers.
 *
 * Reactions are only captured at message-fetch time. To pick up reactions
 * added after the initial sync, we re-fetch each message at a small set of
 * age tiers (see `TIERS`) — enough to cover the great majority of late
 * reactions per the observed reaction-age distribution (see
 * `discord_reaction_observations` below).
 *
 * Per channel, per tier, we keep a cursor: the highest message snowflake we
 * have already re-checked at that tier. Each sync advances the cursor up to
 * `dateToSnowflake(now - tier_age)`, fetching the band of messages that
 * crossed the threshold since the previous sync. Inactive channels skip
 * cheaply via a cursor comparison — no API call.
 *
 * Each re-fetch updates the stored `raw_data.reactions` and records a row in
 * `discord_reaction_observations` (when the message has any reactions). The
 * observations table gives us empirical data for tuning the tier intervals
 * over time.
 */

import type { Database } from "bun:sqlite";
import { conversationTypeClause } from "../../db/conversation-types";
import {
  type DiscordClient,
  type DiscordPoll,
  dateToSnowflake,
  type NormalizedReaction,
  snowflakeToDate,
} from "./client";
import { upsertEmojiRefs } from "./emoji-downloader";
import { type EmojiRef, extractEmojiRefs } from "./emoji-extractor";
import { reconcileDiscordMessage, tombstoneDiscordMessage } from "./message-reconciliation";

// Local observation data showed reaction growth is heavily front-loaded and
// no meaningful changes at the longest sampled interval. The longest tier was
// therefore dropped and an earlier tier added. Its timing is an estimate, not
// a measured optimum — the observations it records are the data to tune it.
//
// Reaction *authors* (who reacted, vs the emoji + count the message fetch
// returns) are now captured at first sync, gated on message age (see
// INITIAL_AUTHOR_CAPTURE_MAX_AGE_MS in the sync source). `refreshAuthorsOnChange`
// marks the tiers that refetch authors when the count changed — including a
// message gaining its first reactions after the initial sync. The 1h/6h/24h
// tiers refresh; 7d stays counts-only (except the don't-clobber refresh below),
// since reactions have long settled by then.
export const TIERS = [
  { name: "1h" as const, durationMs: 60 * 60 * 1000, refreshAuthorsOnChange: true },
  { name: "6h" as const, durationMs: 6 * 60 * 60 * 1000, refreshAuthorsOnChange: true },
  { name: "24h" as const, durationMs: 24 * 60 * 60 * 1000, refreshAuthorsOnChange: true },
  { name: "7d" as const, durationMs: 7 * 24 * 60 * 60 * 1000, refreshAuthorsOnChange: false },
];

export type TierName = (typeof TIERS)[number]["name"];

/**
 * Per-tier re-fetch cursors: tier name → (channel id → highest message
 * snowflake already re-checked at that tier). A dynamic map keyed by the
 * `TIERS` names rather than one field per tier, so the tier set is driven
 * entirely by `TIERS` and the persisted map can still carry (and later prune)
 * cursors for tiers no longer listed.
 */
export type TierCursors = Record<string, Record<string, string>>;

export interface RescanStats {
  channelsChecked: number;       // channels where we made an API call
  channelsSkipped: number;       // channels where cursor check skipped the fetch
  channelsSkippedEmptyBand: number; // channels where the local DB showed an empty band
  messagesReFetched: number;     // total messages re-fetched
  reactionsUpdated: number;      // raw_data.reactions UPDATEs run
  pollsUpdated: number;          // raw_data.poll UPDATEs run
  observationsRecorded: number;  // discord_reaction_observations INSERTs
  messagesEdited: number;        // prior snapshot stored + current event updated
  messagesTombstoned: number;    // confirmed source deletions
  tombstonesCleared: number;     // tombstones repaired by a later observation
  deletionConfirmations: number; // per-message presence checks
}

type StoredPoll = DiscordPoll & { voters?: unknown };

// The rescan can only update messages already stored locally (unknown ids in a
// re-fetched batch are skipped), so a band with no local events is a
// guaranteed no-op and the API call can be skipped. Band edges are widened by
// this margin so a true in-band row can never be string-compared out of the
// window by its timestamp tail (stored discord timestamps mix
// ".ssssss+00:00" and second-precision "+00:00" tails; a false positive just
// costs one empty fetch).
const BAND_PRECHECK_MARGIN_MS = 2000;

// Matches the idx_events_conversation_id partial index: `conversation_id = ?`
// implies its IS NOT NULL predicate, and the type clause is generated from the
// same source. Verified by an EXPLAIN QUERY PLAN test.
export const BAND_PRECHECK_SQL = `
  SELECT 1 FROM events
  WHERE source = 'discord' AND source_account = ? AND conversation_id = ?
    AND ${conversationTypeClause()}
    AND timestamp > ? AND timestamp < ?
  LIMIT 1
`;

function emojiKey(e: { id: string | null; name: string }): string {
  return e.id ? `${e.name}:${e.id}` : e.name;
}

export function buildEmojiCountMap(reactions: NormalizedReaction[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of reactions) {
    map[emojiKey(r.emoji)] = r.count;
  }
  return map;
}

/**
 * Carry stored authors forward when a refresh could not fetch them. The user
 * fetch converts per-emoji 400/403/404 into an empty list (e.g. a custom
 * emoji deleted between capture and refresh), and a reaction with count > 0
 * always has reactors — so empty users on a positive count means the fetch
 * failed, not that everyone unreacted. Writing it through would silently
 * erase previously-captured authors.
 */
export function mergeStoredUsers(
  fetched: NormalizedReaction[],
  stored: NormalizedReaction[],
): NormalizedReaction[] {
  return fetched.map((r) => {
    if (r.count > 0 && (r.users?.length ?? 0) === 0) {
      const priorUsers = stored.find((s) => emojiKey(s.emoji) === emojiKey(r.emoji))?.users;
      if (priorUsers && priorUsers.length > 0) return { ...r, users: priorUsers };
    }
    return r;
  });
}

/**
 * Semantic equality of two reaction arrays — compares emoji→count regardless
 * of array order. Used to short-circuit the UPDATE when nothing has changed,
 * avoiding the FTS + event_people + identity trigger cascade.
 */
export function reactionsEqual(
  a: ReadonlyArray<{ emoji: { id: string | null; name: string }; count: number }>,
  b: ReadonlyArray<{ emoji: { id: string | null; name: string }; count: number }>,
): boolean {
  if (a.length !== b.length) return false;
  const aMap = new Map<string, number>();
  for (const r of a) aMap.set(emojiKey(r.emoji), r.count);
  for (const r of b) {
    if (aMap.get(emojiKey(r.emoji)) !== r.count) return false;
  }
  return true;
}

/**
 * For each (channel, tier), advance the per-tier cursor up to "now - tier_age",
 * re-fetching the band of messages that crossed the threshold since the
 * previous sync. For each re-fetched message, update raw_data.reactions and
 * record a reaction observation row (when count > 0).
 *
 * Errors per-channel are logged and swallowed — the cursor is only advanced
 * on successful completion, so the next sync retries.
 */
export async function rescanReactionTiers(
  client: DiscordClient,
  db: Database,
  cursors: TierCursors,
  channelIds: string[],
  channelHighWater: Record<string, string>,
  sourceAccount: string,
  signal?: AbortSignal,
): Promise<RescanStats> {
  const stats: RescanStats = {
    channelsChecked: 0,
    channelsSkipped: 0,
    channelsSkippedEmptyBand: 0,
    messagesReFetched: 0,
    reactionsUpdated: 0,
    pollsUpdated: 0,
    observationsRecorded: 0,
    messagesEdited: 0,
    messagesTombstoned: 0,
    tombstonesCleared: 0,
    deletionConfirmations: 0,
  };
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // Custom emoji refs discovered in re-fetched reactions. Flushed once at the
  // end so the downloader's later pass picks them up.
  const newEmojiRefs = new Map<string, EmojiRef>();

  const findEvent = db.prepare(
    `SELECT id, timestamp, json_extract(raw_data, '$.reactions') AS reactions_json,
            json_extract(raw_data, '$.poll') AS poll_json
     FROM events WHERE source = 'discord' AND source_id = ? AND source_account = ?`,
  );
  const updateReactions = db.prepare(
    "UPDATE events SET raw_data = json_set(raw_data, '$.reactions', json(?)) WHERE source = 'discord' AND source_id = ? AND source_account = ?",
  );
  const updatePoll = db.prepare(
    "UPDATE events SET raw_data = json_set(raw_data, '$.poll', json(?)) WHERE source = 'discord' AND source_id = ? AND source_account = ?",
  );
  const upsertObservation = db.prepare(
    `INSERT OR REPLACE INTO discord_reaction_observations
       (event_id, tier, observed_at, age_ms, total_count, emoji_counts)
     VALUES (?, ?, ?, ?, ?, json(?))`,
  );
  const hasEventsInBand = db.prepare(BAND_PRECHECK_SQL);
  const findBandEvents = db.prepare(
    `SELECT source_id, source_deleted_observed_at
     FROM events
     WHERE source = 'discord' AND source_account = ? AND conversation_id = ?
       AND ${conversationTypeClause()}
     ORDER BY timestamp DESC`,
  );

  const processRefetchedMessage = async (
    msg: Parameters<typeof reconcileDiscordMessage>[1],
    tier: (typeof TIERS)[number],
    channelId: string,
  ): Promise<void> => {
    const reconciled = reconcileDiscordMessage(db, msg, sourceAccount, nowIso);
    if (reconciled.edited) stats.messagesEdited++;
    if (reconciled.tombstoneCleared) stats.tombstonesCleared++;

    const found = findEvent.get(msg.id, sourceAccount) as
      | {
          id: number;
          timestamp: string;
          reactions_json: string | null;
          poll_json: string | null;
        }
      | undefined;
    if (!found) return;

    stats.messagesReFetched++;
    const stored: NormalizedReaction[] = found.reactions_json
      ? JSON.parse(found.reactions_json)
      : [];
    const changed = !reactionsEqual(stored, msg.reactions);
    const storedHasUsers = stored.some((reaction) => (reaction.users?.length ?? 0) > 0);
    const captureUsers =
      msg.reactions.length > 0 &&
      changed &&
      (storedHasUsers || tier.refreshAuthorsOnChange);
    const nextReactions = captureUsers
      ? mergeStoredUsers(
          await client.fetchAllReactionUsers(channelId, msg.id, msg.reactions),
          stored,
        )
      : msg.reactions;

    if (changed) {
      updateReactions.run(JSON.stringify(nextReactions), msg.id, sourceAccount);
      stats.reactionsUpdated++;
      for (const ref of extractEmojiRefs(msg)) {
        const existing = newEmojiRefs.get(ref.id);
        if (!existing) {
          newEmojiRefs.set(ref.id, { ...ref });
        } else if (ref.animated === true) {
          existing.animated = true;
        } else if (existing.animated === null && ref.animated === false) {
          existing.animated = false;
        }
      }
    }

    if (msg.poll) {
      const storedPoll: StoredPoll | null = found.poll_json
        ? JSON.parse(found.poll_json)
        : null;
      const nextPoll: StoredPoll = storedPoll?.voters
        ? { ...msg.poll, voters: storedPoll.voters }
        : msg.poll;
      if (JSON.stringify(storedPoll) !== JSON.stringify(nextPoll)) {
        updatePoll.run(JSON.stringify(nextPoll), msg.id, sourceAccount);
        stats.pollsUpdated++;
      }
    }

    if (msg.reactions.length > 0) {
      const totalCount = msg.reactions.reduce((sum, reaction) => sum + reaction.count, 0);
      const ageMs = nowMs - Date.parse(found.timestamp);
      upsertObservation.run(
        found.id,
        tier.name,
        nowIso,
        ageMs,
        totalCount,
        JSON.stringify(buildEmojiCountMap(msg.reactions)),
      );
      stats.observationsRecorded++;
    }
  };

  for (const [tierIndex, tier] of TIERS.entries()) {
    const thresholdSnowflake = dateToSnowflake(new Date(nowMs - tier.durationMs));
    const bandEndIso = new Date(nowMs - tier.durationMs + BAND_PRECHECK_MARGIN_MS).toISOString();
    const thresholdBig = BigInt(thresholdSnowflake);
    // Self-seed the bucket: a tier newly added to TIERS arrives without a cursor
    // map, so create one here rather than throw on an undefined bucket below.
    const tierCursors = (cursors[tier.name] ??= {});

    for (const channelId of channelIds) {
      if (signal?.aborted) return stats;

      let cursor: string | undefined = tierCursors[channelId];

      // A newly deployed earlier tier can borrow the nearest later tier's
      // cursor and repair the gap immediately. A genuinely new channel has no
      // later cursor, so it still self-seeds without historical backfill.
      if (!cursor) {
        cursor = TIERS.slice(tierIndex + 1)
          .map((laterTier) => cursors[laterTier.name]?.[channelId])
          .find((laterCursor) => laterCursor !== undefined);
        if (!cursor) {
          tierCursors[channelId] = thresholdSnowflake;
          stats.channelsSkipped++;
          continue;
        }
        tierCursors[channelId] = cursor;
      }

      const cursorBig = BigInt(cursor);

      // Cursor is already at or past the threshold (shouldn't happen, defensive).
      if (cursorBig >= thresholdBig) {
        stats.channelsSkipped++;
        continue;
      }

      // No messages exist past the cursor yet — skip the API call but advance
      // the cursor so we don't keep checking next sync.
      const highWater = channelHighWater[channelId];
      if (!highWater || BigInt(highWater) <= cursorBig) {
        tierCursors[channelId] = thresholdSnowflake;
        stats.channelsSkipped++;
        continue;
      }

      // The channel has messages newer than the cursor (highWater), but they
      // may all be younger than the tier threshold — then the band itself is
      // empty and the fetch would return nothing. Consult the local DB first.
      const bandStartIso = new Date(
        snowflakeToDate(cursor).getTime() - BAND_PRECHECK_MARGIN_MS,
      ).toISOString();
      if (!hasEventsInBand.get(sourceAccount, channelId, bandStartIso, bandEndIso)) {
        tierCursors[channelId] = thresholdSnowflake;
        stats.channelsSkippedEmptyBand++;
        continue;
      }

      stats.channelsChecked++;
      let success = true;
      try {
        const localIds = new Map<string, string | null>();
        const allLocalIds: string[] = [];
        for (const row of findBandEvents.all(sourceAccount, channelId) as Array<{
          source_id: string | null;
          source_deleted_observed_at: string | null;
        }>) {
          if (!row.source_id) continue;
          allLocalIds.push(row.source_id);
          const id = BigInt(row.source_id);
          if (id > cursorBig && id < thresholdBig) {
            localIds.set(row.source_id, row.source_deleted_observed_at);
          }
        }

        const observedIds = new Set<string>();
        let traversalComplete = false;
        for await (const batch of client.fetchMessagesInRange(
          channelId,
          cursor,
          thresholdSnowflake,
          { onComplete: () => { traversalComplete = true; } },
        )) {
          if (signal?.aborted) {
            success = false;
            break;
          }
          for (const msg of batch) {
            observedIds.add(msg.id);
            await processRefetchedMessage(msg, tier, channelId);
          }
        }

        if (success && !traversalComplete) success = false;

        if (success) {
          const pendingTombstones: string[] = [];
          let historyAccessProven = observedIds.size > 0;
          for (const [messageId, deletedObservedAt] of localIds) {
            if (observedIds.has(messageId) || deletedObservedAt !== null) continue;
            stats.deletionConfirmations++;
            const presence = await client.checkMessagePresence(channelId, messageId);
            if (presence.kind === "unavailable") {
              success = false;
              break;
            }
            if (presence.kind === "found") {
              historyAccessProven = true;
              await processRefetchedMessage(presence.message, tier, channelId);
              continue;
            }
            pendingTombstones.push(messageId);
          }

          // Discord can answer 200 + [] when READ_MESSAGE_HISTORY is missing.
          // Before treating any 200 omission as a deletion, require a positive
          // control: an actual message returned from this channel in the same
          // run. Probe a few known messages outside the band when the traversal
          // and candidate confirmations returned no messages at all.
          if (success && pendingTombstones.length > 0 && !historyAccessProven) {
            const controls = allLocalIds.filter((id) => !localIds.has(id)).slice(0, 5);
            for (const controlId of controls) {
              stats.deletionConfirmations++;
              const control = await client.checkMessagePresence(channelId, controlId);
              if (control.kind === "unavailable") {
                success = false;
                break;
              }
              if (control.kind === "found") {
                historyAccessProven = true;
                const reconciled = reconcileDiscordMessage(db, control.message, sourceAccount, nowIso);
                if (reconciled.edited) stats.messagesEdited++;
                if (reconciled.tombstoneCleared) stats.tombstonesCleared++;
                break;
              }
            }
            if (!historyAccessProven) success = false;
          }

          if (signal?.aborted) success = false;
          if (success && pendingTombstones.length > 0) {
            const tombstoned = db.transaction(() => {
              let count = 0;
              for (const messageId of pendingTombstones) {
                if (tombstoneDiscordMessage(db, messageId, sourceAccount, nowIso)) count++;
              }
              return count;
            })();
            stats.messagesTombstoned += tombstoned;
          }
        }
      } catch (err) {
        console.warn(
          `[discord] rescan ${tier.name} channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        success = false;
      }

      // Only advance the cursor on a clean run so retries pick up next sync.
      if (success) {
        tierCursors[channelId] = thresholdSnowflake;
      }
    }
  }

  if (newEmojiRefs.size > 0) {
    upsertEmojiRefs(db, [...newEmojiRefs.values()]);
  }

  return stats;
}
