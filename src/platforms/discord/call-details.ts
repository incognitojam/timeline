import type { Database } from "bun:sqlite";
import type { NormalizedMessage } from "./client";

export const DISCORD_CALL_DETAIL_REFRESH_LIMIT = 25;

interface CallDetailClient {
  fetchMessage(channelId: string, messageId: string): Promise<NormalizedMessage | null>;
}

interface CallDetailCandidate {
  message_id: string;
  channel_id: string;
  call_json: string | null;
}

export interface CallDetailRefreshStats {
  attempted: number;
  updated: number;
  pending: number;
  unavailable: number;
  failed: number;
}

const CALL_DETAIL_CANDIDATES_SQL = `
  SELECT source_id AS message_id,
         json_extract(raw_data, '$._channel.id') AS channel_id,
         json_extract(raw_data, '$.call') AS call_json
  FROM events INDEXED BY idx_events_source_type
  WHERE source = 'discord'
    AND source_account = ?
    AND type IN ('message:dm:call', 'message:group:call', 'message:guild:call')
    AND source_id IS NOT NULL
    AND json_type(raw_data, '$.call.ended_timestamp') IS NOT 'text'
    AND json_type(raw_data, '$._channel.id') = 'text'
    AND (? IS NULL OR import_batch IS NOT ?)
  ORDER BY timestamp, id
`;

/**
 * Re-fetch calls first stored while they were still active. Discord mutates the
 * call object with ended_timestamp after the call finishes, but the ordinary
 * message sync is append-only and will not encounter that message again.
 *
 * Completed calls leave the recovery set after their payload is updated. Calls
 * that are still active remain eligible for a later sync, while unavailable
 * messages are remembered by the caller so they do not cost a request on every
 * sync.
 */
export async function refreshIncompleteCallDetails(
  client: CallDetailClient,
  db: Database,
  sourceAccount: string,
  unavailableMessageIds: Set<string>,
  options: {
    currentImportBatch?: string;
    signal?: AbortSignal;
    limit?: number;
  } = {},
): Promise<CallDetailRefreshStats> {
  const stats: CallDetailRefreshStats = {
    attempted: 0,
    updated: 0,
    pending: 0,
    unavailable: 0,
    failed: 0,
  };
  const candidates = (db.prepare(CALL_DETAIL_CANDIDATES_SQL).all(
    sourceAccount,
    options.currentImportBatch ?? null,
    options.currentImportBatch ?? null,
  ) as CallDetailCandidate[])
    .filter((candidate) => !unavailableMessageIds.has(candidate.message_id))
    .slice(0, options.limit ?? DISCORD_CALL_DETAIL_REFRESH_LIMIT);
  const updateCall = db.prepare(`
    UPDATE events
    SET raw_data = json_set(raw_data, '$.call', json(?))
    WHERE source = 'discord' AND source_id = ? AND source_account = ?
  `);

  for (const candidate of candidates) {
    if (options.signal?.aborted) {
      throw new DOMException("Discord sync aborted", "AbortError");
    }

    stats.attempted++;
    try {
      const message = await client.fetchMessage(candidate.channel_id, candidate.message_id);
      if (!message) {
        unavailableMessageIds.add(candidate.message_id);
        stats.unavailable++;
        continue;
      }

      const call = message.call;
      if (!call) {
        unavailableMessageIds.add(candidate.message_id);
        stats.unavailable++;
        continue;
      }

      const nextCall = {
        participants: call.participants,
        ...(call.endedTimestamp ? { ended_timestamp: call.endedTimestamp } : {}),
      };
      if (candidate.call_json !== JSON.stringify(nextCall)) {
        const result = updateCall.run(
          JSON.stringify(nextCall),
          candidate.message_id,
          sourceAccount,
        );
        if (result.changes > 0) stats.updated++;
      }
      if (!call.endedTimestamp) {
        stats.pending++;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      stats.failed++;
      console.warn(
        `[discord] call detail refresh failed for ${candidate.message_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return stats;
}
