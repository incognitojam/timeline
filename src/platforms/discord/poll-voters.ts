import type { Database } from "bun:sqlite";
import type { PollVoter } from "./client";

export const POLL_VOTER_CAPTURE_LIMIT = 25;

export interface PollVoterCaptureStats {
  captured: number;
  failed: number;
  remaining: number;
}

interface PollVoterClient {
  fetchPollAnswerVoters(
    channelId: string,
    messageId: string,
    answerId: number,
  ): Promise<PollVoter[]>;
}

interface StoredPoll {
  answers: Array<{ answer_id: number }>;
}

interface PollVoterCandidate {
  source_id: string;
  channel_id: string | null;
  poll_json: string;
}

const POLL_VOTER_CANDIDATE_WHERE = `
  source = 'discord'
    AND source_account = ?
    AND json_extract(raw_data, '$.poll') IS NOT NULL
    AND json_extract(raw_data, '$.poll.voters') IS NULL
    AND (
      json_extract(raw_data, '$.poll.expiry') <= ?
      OR json_extract(raw_data, '$.poll.results.is_finalized') = 1
    )
`;

/**
 * Capture final poll voter lists once. Poll votes remain mutable until expiry,
 * so open polls are deliberately excluded; the stored `poll.voters` object is
 * the completion marker that prevents another voter capture.
 */
export async function captureExpiredPollVoters(
  client: PollVoterClient,
  db: Database,
  sourceAccount: string,
  signal?: AbortSignal,
): Promise<PollVoterCaptureStats> {
  const now = new Date().toISOString();
  const countCandidates = db.prepare(
    `SELECT COUNT(*) AS count FROM events WHERE ${POLL_VOTER_CANDIDATE_WHERE}`,
  );
  const findCandidates = db.prepare(`
    SELECT source_id,
           json_extract(raw_data, '$._channel.id') AS channel_id,
           json_extract(raw_data, '$.poll') AS poll_json
    FROM events
    WHERE ${POLL_VOTER_CANDIDATE_WHERE}
    ORDER BY timestamp DESC, source_id
    LIMIT ?
  `);
  const updateVoters = db.prepare(
    "UPDATE events SET raw_data = json_set(raw_data, '$.poll.voters', json(?)) WHERE source = 'discord' AND source_id = ? AND source_account = ?",
  );
  const candidates = findCandidates.all(
    sourceAccount,
    now,
    POLL_VOTER_CAPTURE_LIMIT,
  ) as PollVoterCandidate[];
  let captured = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (signal?.aborted) break;

    try {
      if (!candidate.channel_id) {
        throw new Error("stored poll is missing raw_data._channel.id");
      }
      const poll = JSON.parse(candidate.poll_json) as StoredPoll;
      const answers: Record<string, PollVoter[]> = {};
      for (const answer of poll.answers) {
        answers[String(answer.answer_id)] = await client.fetchPollAnswerVoters(
          candidate.channel_id,
          candidate.source_id,
          answer.answer_id,
        );
      }

      updateVoters.run(
        JSON.stringify({ captured_at: new Date().toISOString(), answers }),
        candidate.source_id,
        sourceAccount,
      );
      captured++;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      failed++;
      console.warn(
        `[discord] poll voter capture failed for ${candidate.source_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const remainingRow = countCandidates.get(sourceAccount, now) as { count: number };
  return { captured, failed, remaining: remainingRow.count };
}
