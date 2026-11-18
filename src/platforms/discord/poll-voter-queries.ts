export const PENDING_POLL_VOTERS_INDEX = "idx_events_discord_poll_voters_pending";

// Time-dependent eligibility belongs in the query, so open polls age into the index's work set.
// Unattempted polls go first; failed polls rotate behind them without losing retry eligibility.
export const POLL_VOTER_ORDER = "json_extract(raw_data, '$.poll.voter_attempted_at'), timestamp DESC, source_id";

export const PENDING_POLL_VOTERS_WHERE = `
  source = 'discord'
  AND CASE WHEN json_valid(raw_data) THEN
    json_extract(raw_data, '$.poll') IS NOT NULL
    AND json_extract(raw_data, '$.poll.voters') IS NULL
  ELSE 0 END
`;

const CANDIDATE_WHERE = `${PENDING_POLL_VOTERS_WHERE}
  AND source_account = ?
  AND (
    json_extract(raw_data, '$.poll.expiry') <= ?
    OR json_extract(raw_data, '$.poll.results.is_finalized') = 1
  )`;

export const FIND_POLL_VOTER_CANDIDATES = `
  SELECT source_id,
         json_extract(raw_data, '$._channel.id') AS channel_id,
         json_extract(raw_data, '$.poll') AS poll_json
  FROM events INDEXED BY ${PENDING_POLL_VOTERS_INDEX} WHERE ${CANDIDATE_WHERE}
  ORDER BY ${POLL_VOTER_ORDER}
  LIMIT ?
`;

export const COUNT_POLL_VOTER_CANDIDATES = `
  SELECT COUNT(*) AS count FROM events INDEXED BY ${PENDING_POLL_VOTERS_INDEX} WHERE ${CANDIDATE_WHERE}
`;
