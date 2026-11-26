import type { Database } from "bun:sqlite";
import {
  MUSIC_PERIODS,
  type MusicExclusion,
  type MusicExclusionKind,
  type MusicExclusionRequest,
  type MusicPeriod,
  type MusicRankingsOverview,
  type MusicRankedArtist,
  type MusicRankedTrack,
  type MusicRecentPlay,
  type MusicTopListFilter,
} from "./shared/music";

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

const ALBUM_ARTIST_SQL = `COALESCE(
  json_extract(e.raw_data, '$.track.album.artists[0].name'),
  json_extract(e.raw_data, '$.track.artists[0].name'),
  json_extract(e.raw_data, '$.master_metadata_album_artist_name'),
  (
    SELECT substr(artist.value, length('artist:') + 1)
    FROM json_each(CASE WHEN json_valid(e.tags) THEN e.tags ELSE '[]' END) artist
    WHERE artist.value LIKE 'artist:%'
    LIMIT 1
  )
)`;

/**
 * An album is its name and its first artist: export history records no album
 * id, so an id would only ever match live-synced plays.
 */
const ALBUM_KEY_SQL = `${ALBUM_NAME_SQL} || char(31) || ${ALBUM_ARTIST_SQL}`;

const TAGS_SQL = `json_each(CASE WHEN json_valid(e.tags) THEN e.tags ELSE '[]' END)`;

/** Only live-synced plays keep Spotify's play context; export history has none. */
const PLAYLIST_URI_SQL = `CASE
  WHEN json_extract(e.raw_data, '$.context.type') = 'playlist'
  THEN json_extract(e.raw_data, '$.context.uri')
END`;

/** The sync tags a play with its playlist's name when it could look the name up. */
const PLAYLIST_NAME_SQL = `(
  SELECT substr(playlist.value, length('playlist:') + 1)
  FROM ${TAGS_SQL} playlist
  WHERE playlist.value LIKE 'playlist:%'
  LIMIT 1
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

interface StoredExclusion extends MusicExclusion {
  matchKey: string;
}

/** The top-list filter as stored in app-state.db, with the keys plays are matched on. */
export interface StoredTopListFilter {
  exclusions: StoredExclusion[];
  excludePrivateSessions: boolean;
}

const EXCLUDE_PRIVATE_SESSIONS_KEY = "music_exclude_private_sessions";

export function getTopListFilter(appDb: Database): StoredTopListFilter {
  const exclusions = appDb.prepare(`
    SELECT id, kind, label, match_key AS matchKey FROM music_exclusions ORDER BY id
  `).all() as StoredExclusion[];
  const setting = appDb.prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(EXCLUDE_PRIVATE_SESSIONS_KEY) as { value: string } | null;
  return { exclusions, excludePrivateSessions: setting !== null && JSON.parse(setting.value) === true };
}

/** The filter without its match keys, as the API returns it. */
export function publicTopListFilter(filter: StoredTopListFilter): MusicTopListFilter {
  return {
    exclusions: filter.exclusions.map(({ id, kind, label }) => ({ id, kind, label })),
    excludePrivateSessions: filter.excludePrivateSessions,
  };
}

export function setExcludePrivateSessions(appDb: Database, excluded: boolean): void {
  appDb.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(EXCLUDE_PRIVATE_SESSIONS_KEY, JSON.stringify(excluded));
}

/**
 * Resolve what a request excludes to the key plays are matched on, reading the
 * play it names from timeline.db. Null when that play does not record it — a
 * playlist, for one, is only known for live-synced plays.
 */
export function resolveExclusion(
  db: Database,
  request: MusicExclusionRequest,
  playlistNames: (uri: string) => string | null,
): { kind: MusicExclusionKind; matchKey: string; label: string } | null {
  if (request.kind === "artist") {
    return { kind: "artist", matchKey: request.artistName, label: request.artistName };
  }
  const play = db.prepare(`
    SELECT
      e.title AS trackName,
      ${ARTIST_NAMES_SQL} AS artistName,
      ${TRACK_URI_SQL} AS trackUri,
      ${ALBUM_NAME_SQL} AS albumName,
      ${ALBUM_ARTIST_SQL} AS albumArtist,
      ${ALBUM_KEY_SQL} AS albumKey,
      ${PLAYLIST_URI_SQL} AS playlistUri,
      ${PLAYLIST_NAME_SQL} AS playlistName
    FROM events e
    WHERE e.id = ? AND e.source = 'spotify' AND e.type = 'listen:track'
  `).get(request.eventId) as {
    trackName: string | null;
    artistName: string | null;
    trackUri: string | null;
    albumName: string | null;
    albumArtist: string | null;
    albumKey: string | null;
    playlistUri: string | null;
    playlistName: string | null;
  } | null;
  if (!play) return null;
  const byline = (name: string | null, artist: string | null) =>
    [name ?? "Unknown", artist].filter(Boolean).join(" · ");

  if (request.kind === "track") {
    return play.trackUri
      ? { kind: "track", matchKey: play.trackUri, label: byline(play.trackName, play.artistName) }
      : null;
  }
  if (request.kind === "album") {
    return play.albumKey
      ? { kind: "album", matchKey: play.albumKey, label: byline(play.albumName, play.albumArtist) }
      : null;
  }
  return play.playlistUri
    ? {
      kind: "playlist",
      matchKey: play.playlistUri,
      label: play.playlistName ?? playlistNames(play.playlistUri) ?? play.playlistUri,
    }
    : null;
}

export function addExclusion(
  appDb: Database,
  exclusion: { kind: MusicExclusionKind; matchKey: string; label: string },
): MusicExclusion {
  return appDb.prepare(`
    INSERT INTO music_exclusions (kind, match_key, label) VALUES (?, ?, ?)
    ON CONFLICT (kind, match_key) DO UPDATE SET label = excluded.label
    RETURNING id, kind, label
  `).get(exclusion.kind, exclusion.matchKey, exclusion.label) as MusicExclusion;
}

export function removeExclusion(appDb: Database, id: number): boolean {
  return appDb.prepare("DELETE FROM music_exclusions WHERE id = ?").run(id).changes > 0;
}

/**
 * WHERE clauses that leave excluded plays out of the top lists. Each list of
 * keys is one JSON parameter, so the clause text only varies with which kinds
 * are in use, and SQLite evaluates each `IN` subquery once per statement.
 */
function topListFilterSql(filter: StoredTopListFilter): { sql: string; params: string[] } {
  const keys = (kind: MusicExclusionKind) => filter.exclusions
    .filter((exclusion) => exclusion.kind === kind)
    .map((exclusion) => exclusion.matchKey);
  const clauses: string[] = [];
  const params: string[] = [];
  const notIn = (kind: MusicExclusionKind, expressions: string[]) => {
    const list = keys(kind);
    if (list.length === 0) return;
    for (const expression of expressions) {
      clauses.push(expression);
      params.push(JSON.stringify(list));
    }
  };

  // COALESCE: a play that lacks the value is not excluded by it (NULL NOT IN is NULL).
  notIn("track", [`COALESCE(${TRACK_URI_SQL}, '') NOT IN (SELECT value FROM json_each(?))`]);
  notIn("album", [`COALESCE(${ALBUM_KEY_SQL}, '') NOT IN (SELECT value FROM json_each(?))`]);
  notIn("playlist", [`COALESCE(${PLAYLIST_URI_SQL}, '') NOT IN (SELECT value FROM json_each(?))`]);
  // Artists by name, as the artist list ranks them: export history has no artist ids.
  notIn("artist", [
    `NOT EXISTS (SELECT 1 FROM ${TAGS_SQL} tag WHERE tag.value IN (SELECT 'artist:' || value FROM json_each(?)))`,
    `COALESCE(json_extract(e.raw_data, '$.master_metadata_album_artist_name'), '') NOT IN (SELECT value FROM json_each(?))`,
  ]);
  if (filter.excludePrivateSessions) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM ${TAGS_SQL} tag WHERE tag.value = 'incognito')`);
  }
  return { sql: clauses.map((clause) => `AND ${clause}`).join("\n"), params };
}

export function getMusicRankings(
  db: Database,
  period: MusicPeriod,
  options: { now?: Date; limit?: number; filter?: StoredTopListFilter } = {},
): MusicRankingsOverview {
  const periodStart = getMusicPeriodStart(period, options.now);
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const cutoffSql = periodStart === null ? "" : "AND e.timestamp >= ?";
  const cutoffParams = periodStart === null ? [] : [periodStart];
  const filter = options.filter ?? { exclusions: [], excludePrivateSessions: false };
  const excluded = topListFilterSql(filter);
  // The summary keeps counting every play; only the ranked lists are filtered.
  const listedSql = `${cutoffSql}\n${excluded.sql}`;
  const listedParams = [...cutoffParams, ...excluded.params];

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
        ${listedSql}
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
  `).all(...listedParams, limit) as TrackAggregateRow[];

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
        ${listedSql}
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
        ${listedSql}
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
  `).all(...listedParams, ...listedParams, limit) as ArtistAggregateRow[];

  return {
    period,
    periodStart,
    ...summary,
    topTracks: trackRows.map((row, index) => ({ ...row, rank: index + 1 })),
    topArtists: artistRows.map((row, index) => ({ ...row, rank: index + 1 })),
    filter: publicTopListFilter(filter),
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
      ${IMAGE_URL_SQL} AS imageUrl,
      ${PLAYLIST_URI_SQL} AS playlistUri,
      ${PLAYLIST_NAME_SQL} AS playlistName
    FROM events e
    WHERE e.source = 'spotify'
      AND e.type = 'listen:track'
      AND e.timestamp IS NOT NULL
      AND e.title IS NOT NULL
    ORDER BY e.timestamp DESC, e.id DESC
    LIMIT ?
  `).all(limit) as MusicRecentPlay[];
}
