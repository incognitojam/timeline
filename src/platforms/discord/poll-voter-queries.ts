export const PENDING_POLL_VOTERS_INDEX = "idx_events_discord_poll_voters_pending";

// Time-dependent eligibility belongs in the query, so open polls age into the index's work set.
export const PENDING_POLL_VOTERS_WHERE = `
  source = 'discord'
  AND json_extract(raw_data, '$.poll') IS NOT NULL
  AND json_extract(raw_data, '$.poll.voters') IS NULL
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
  ORDER BY timestamp DESC, source_id
  LIMIT ?
`;

export const COUNT_POLL_VOTER_CANDIDATES = `
  SELECT COUNT(*) AS count FROM events INDEXED BY ${PENDING_POLL_VOTERS_INDEX} WHERE ${CANDIDATE_WHERE}
`;
