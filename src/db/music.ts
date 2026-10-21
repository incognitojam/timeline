import type { Database } from "bun:sqlite";
import {
  MUSIC_PERIODS,
  type MusicPeriod,
  type MusicRankingsOverview,
  type MusicRankedArtist,
  type MusicRankedTrack,
  type MusicRecentPlay,
} from "../shared/music";

type TrackAggregateRow = Omit<MusicRankedTrack, "rank">;
type ArtistAggregateRow = Omit<MusicRankedArtist, "rank">;
interface SummaryRow {
  totalPlays: number;
  listeningMs: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
}

const ARTIST_NAMES_SQL = `COALESCE(
  (
    SELECT group_concat(substr(artist.value, length('artist:') + 1), ', ')
    FROM json_each(CASE WHEN json_valid(e.tags) THEN e.tags ELSE '[]' END) artist
    WHERE artist.value LIKE 'artist:%'
  ),
  json_extract(e.raw_data, '$.master_metadata_album_artist_name')
)`;

const TRACK_URI_SQL = `COALESCE(
  json_extract(e.raw_data, '$.track.uri'),
  json_extract(e.raw_data, '$.spotify_track_uri'),
  CASE
    WHEN e.source_id LIKE 'spotify:track:%@%'
    THEN substr(e.source_id, 1, instr(e.source_id, '@') - 1)
  END
)`;

const IMAGE_URL_SQL = `COALESCE(
  json_extract(e.raw_data, '$.track.album.images[1].url'),
  json_extract(e.raw_data, '$.track.album.images[2].url'),
  json_extract(e.raw_data, '$.track.album.images[0].url'),
  json_extract(e.raw_data, '$.track.imageUrl')
)`;

const ALBUM_NAME_SQL = `COALESCE(
  json_extract(e.raw_data, '$.track.album.name'),
  json_extract(e.raw_data, '$.master_metadata_album_album_name')
)`;

/**
 * Shortest gap between two reported plays that carries any signal.
 *
 * Spotify reports a play only once it passes 30s, so a shorter gap between two
 * reported plays is self-contradictory: it comes from timestamps the client
 * reconstructed in a burst (offline playback), or from comparing a
 * second-precision timestamp against a millisecond one. Neither says anything
 * about how long the track played.
 */
const MIN_TRUSTED_GAP_MS = 30_000;

const TRACK_LENGTH_SQL = `json_extract(e.raw_data, '$.track.duration_ms')`;

/**
 * Milliseconds since the previous play that also lacks a measured duration.
 *
 * A play's `played_at` marks when the track *stopped*, so this interval bounds
 * how long the track had to play in. Restricted to unmeasured plays because only
 * those consult it; the gap therefore spans any measured play sitting between
 * two unmeasured ones, which only ever trims less.
 *
 * Ordered lexically, which is not chronological when a second-precision
 * timestamp meets a millisecond one in the same second ('.' sorts below 'Z'), so
 * this can select a play that is fractionally later and yield a negative gap.
 * Callers must treat gaps below MIN_TRUSTED_GAP_MS as no signal rather than
 * clamping them.
 *
 * Must seek idx_events_source_timestamp — ORDER BY/LIMIT does, but
 * `MAX(julianday(timestamp))` does not: a function around the column drops the
 * index and scans every row preceding this one. ROUND because julianday
 * arithmetic is floating point and truncation would bias every gap downward.
 *
 * The lookback bound keeps that seek to a range: without it the earliest
 * unmeasured play walks the whole measured era looking for a predecessor it can
 * never have. Any bound above the longest possible track is equivalent, since a
 * gap that large already yields the full length through MIN.
 */
const PLAY_GAP_MS_SQL = `CAST(ROUND((
  julianday(e.timestamp) - julianday((
    SELECT prev.timestamp
    FROM events prev
    WHERE prev.source = 'spotify'
      AND prev.type = 'listen:track'
      AND prev.duration_ms IS NULL
      AND prev.timestamp < e.timestamp
      AND prev.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', e.timestamp, '-1 day')
    ORDER BY prev.timestamp DESC
    LIMIT 1
  ))
) * 86400000) AS INTEGER)`;

/**
 * Time spent on a play. Export rows measure it: the parser stores the export's
 * `ms_played` in duration_ms. API-synced plays have no listened-time equivalent,
 * so they take the track's length trimmed to the gap since the previous play —
 * a track cannot have played longer than the window it had available.
 *
 * A gap below MIN_TRUSTED_GAP_MS carries no information, so those plays keep
 * their full length rather than being clamped to the threshold — clamping would
 * assert a listening time nothing supports and undercount offline playback. The
 * result is therefore always an upper bound: a play left paused mid-track counts
 * up to its full length.
 *
 * The estimate stays at read time rather than being written to duration_ms,
 * which means measured time elsewhere (the export renderer prints it as the
 * event's duration) and would otherwise become indistinguishable from a guess.
 *
 * MIN here is SQLite's two-argument scalar function; reducing it to one argument
 * silently becomes the aggregate and collapses the surrounding query to a row.
 */
const LISTENING_MS_SQL = `COALESCE(
  e.duration_ms,
  CASE
    WHEN ${PLAY_GAP_MS_SQL} >= ${MIN_TRUSTED_GAP_MS}
      THEN MIN(${TRACK_LENGTH_SQL}, ${PLAY_GAP_MS_SQL})
    ELSE ${TRACK_LENGTH_SQL}
  END,
  0
)`;

export function isMusicPeriod(value: string): value is MusicPeriod {
  return MUSIC_PERIODS.some((period) => period === value);
}

export function getMusicPeriodStart(period: MusicPeriod, now = new Date()): string | null {
  if (period === "all") return null;

  const start = new Date(now);
  if (period === "4w") start.setUTCDate(start.getUTCDate() - 28);
  if (period === "6m") start.setUTCMonth(start.getUTCMonth() - 6);
  if (period === "12m") start.setUTCFullYear(start.getUTCFullYear() - 1);
  return start.toISOString();
}

export function getMusicRankings(
  db: Database,
  period: MusicPeriod,
  options: { now?: Date; limit?: number } = {},
): MusicRankingsOverview {
  const periodStart = getMusicPeriodStart(period, options.now);
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const cutoffSql = periodStart === null ? "" : "AND e.timestamp >= ?";
  const cutoffParams = periodStart === null ? [] : [periodStart];

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS totalPlays,
      COALESCE(SUM(${LISTENING_MS_SQL}), 0) AS listeningMs,
      MIN(e.timestamp) AS firstPlayedAt,
      MAX(e.timestamp) AS lastPlayedAt
    FROM events e
    WHERE e.source = 'spotify'
      AND e.type = 'listen:track'
      AND e.timestamp IS NOT NULL
      ${cutoffSql}
  `).get(...cutoffParams) as SummaryRow;

  const trackRows = db.prepare(`
    WITH listens AS (
      SELECT
        e.id AS eventId,
        e.timestamp AS lastPlayedAt,
        e.title AS trackName,
        ${ARTIST_NAMES_SQL} AS artistName,
        ${ALBUM_NAME_SQL} AS albumName,
        ${TRACK_URI_SQL} AS trackUri,
        ${IMAGE_URL_SQL} AS imageUrl,
        ${LISTENING_MS_SQL} AS listeningMs
      FROM events e
      WHERE e.source = 'spotify'
        AND e.type = 'listen:track'
        AND e.timestamp IS NOT NULL
        AND e.title IS NOT NULL
        ${cutoffSql}
    ), keyed AS (
      SELECT *, COALESCE(trackUri, trackName || char(31) || COALESCE(artistName, '')) AS trackKey
      FROM listens
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY trackKey ORDER BY lastPlayedAt DESC, eventId DESC
      ) AS latestRank
      FROM keyed
    )
    SELECT
      MAX(CASE WHEN latestRank = 1 THEN trackName END) AS trackName,
      MAX(CASE WHEN latestRank = 1 THEN artistName END) AS artistName,
      MAX(CASE WHEN latestRank = 1 THEN albumName END) AS albumName,
      MAX(CASE WHEN latestRank = 1 THEN trackUri END) AS trackUri,
      MAX(CASE WHEN latestRank = 1 THEN imageUrl END) AS imageUrl,
      COUNT(*) AS playCount,
      SUM(listeningMs) AS listeningMs,
      MAX(lastPlayedAt) AS lastPlayedAt,
      MAX(CASE WHEN latestRank = 1 THEN eventId END) AS eventId
    FROM ranked
    GROUP BY trackKey
    ORDER BY playCount DESC, listeningMs DESC, lastPlayedAt DESC
    LIMIT ?
  `).all(...cutoffParams, limit) as TrackAggregateRow[];

  const artistRows = db.prepare(`
    WITH tagged_artist_listens AS (
      SELECT DISTINCT
        e.id AS eventId,
        e.timestamp AS lastPlayedAt,
        e.title AS latestTrackName,
        ${TRACK_URI_SQL} AS latestTrackUri,
        ${IMAGE_URL_SQL} AS imageUrl,
        ${LISTENING_MS_SQL} AS listeningMs,
        substr(artist.value, length('artist:') + 1) AS artistName
      FROM events e
      JOIN json_each(CASE WHEN json_valid(e.tags) THEN e.tags ELSE '[]' END) artist
      WHERE e.source = 'spotify'
        AND e.type = 'listen:track'
        AND e.timestamp IS NOT NULL
        AND artist.value LIKE 'artist:%'
        ${cutoffSql}
    ), export_artist_listens AS (
      SELECT
        e.id AS eventId,
        e.timestamp AS lastPlayedAt,
        e.title AS latestTrackName,
        ${TRACK_URI_SQL} AS latestTrackUri,
        ${IMAGE_URL_SQL} AS imageUrl,
        ${LISTENING_MS_SQL} AS listeningMs,
        json_extract(e.raw_data, '$.master_metadata_album_artist_name') AS artistName
      FROM events e
      WHERE e.source = 'spotify'
        AND e.type = 'listen:track'
        AND e.timestamp IS NOT NULL
        AND json_extract(e.raw_data, '$.master_metadata_album_artist_name') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(CASE WHEN json_valid(e.tags) THEN e.tags ELSE '[]' END) artist
          WHERE artist.value LIKE 'artist:%'
        )
        ${cutoffSql}
    ), artist_listens AS (
      SELECT * FROM tagged_artist_listens
      UNION ALL
      SELECT * FROM export_artist_listens
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY artistName ORDER BY lastPlayedAt DESC, eventId DESC
      ) AS latestRank
      FROM artist_listens
    )
    SELECT
      artistName,
      COUNT(*) AS playCount,
      SUM(listeningMs) AS listeningMs,
      MAX(lastPlayedAt) AS lastPlayedAt,
      MAX(CASE WHEN latestRank = 1 THEN latestTrackName END) AS latestTrackName,
      MAX(CASE WHEN latestRank = 1 THEN latestTrackUri END) AS latestTrackUri,
      MAX(CASE WHEN latestRank = 1 THEN imageUrl END) AS imageUrl,
      MAX(CASE WHEN latestRank = 1 THEN eventId END) AS eventId
    FROM ranked
    GROUP BY artistName
    ORDER BY playCount DESC, listeningMs DESC, lastPlayedAt DESC
    LIMIT ?
  `).all(...cutoffParams, ...cutoffParams, limit) as ArtistAggregateRow[];

  return {
    period,
    periodStart,
    ...summary,
    topTracks: trackRows.map((row, index) => ({ ...row, rank: index + 1 })),
    topArtists: artistRows.map((row, index) => ({ ...row, rank: index + 1 })),
  };
}

export function getRecentMusicPlays(db: Database, requestedLimit = 10): MusicRecentPlay[] {
  const limit = Math.min(Math.max(requestedLimit, 1), 50);
  return db.prepare(`
    SELECT
      e.id AS eventId,
      e.timestamp,
      e.title AS trackName,
      ${ARTIST_NAMES_SQL} AS artistName,
      ${ALBUM_NAME_SQL} AS albumName,
      ${TRACK_URI_SQL} AS trackUri,
      ${IMAGE_URL_SQL} AS imageUrl
    FROM events e
    WHERE e.source = 'spotify'
      AND e.type = 'listen:track'
      AND e.timestamp IS NOT NULL
      AND e.title IS NOT NULL
    ORDER BY e.timestamp DESC, e.id DESC
    LIMIT ?
  `).all(limit) as MusicRecentPlay[];
}
