/**
 * Spotify playlist follower observations.
 *
 * Helpers for the `spotify_playlist_observations` table (defined in schema.ts):
 * a time series of a playlist's public follower count (the "saves"/likes number
 * shown in the Spotify UI). Shared by the `spotify-playlists` sync source and
 * the seed-import script.
 */

import type { Database } from "bun:sqlite";

export interface PlaylistObservationInput {
  /** Spotify playlist ID (not a URL/URI - use extractPlaylistId first). */
  playlistId: string;
  /** Observation day, YYYY-MM-DD. The (playlist, day) pair is the primary key. */
  observedDate: string;
  /** ISO 8601 timestamp of the reading we kept for this day. */
  observedAt: string;
  /** followers.total at observation time. */
  followerCount: number;
  /** Playlist name at observation time, if known. */
  name?: string | null;
  /** 'api' for synced readings, 'seed' for manually backfilled history. */
  origin: "api" | "seed";
  /** Original payload (API response or seed row) for reprocessing. */
  rawData?: unknown;
}

export interface PlaylistObservation {
  playlist_id: string;
  observed_date: string;
  observed_at: string;
  follower_count: number;
  name: string | null;
  origin: string;
  raw_data: string | null;
}

export interface TrackedPlaylist {
  playlist_id: string;
  name: string | null;
  latest_count: number;
  latest_date: string;
  first_date: string;
  observations: number;
  /** Best-effort playlist creation date (ISO 8601), or null if not yet known. */
  created_at: string | null;
}

export interface PlaylistMeta {
  playlist_id: string;
  /** Earliest track added_at (ISO 8601) as a creation proxy, or null if unknown. */
  created_at: string | null;
  /** ISO 8601 timestamp of when created_at was last computed. */
  checked_at: string;
}

/**
 * Upsert one daily observation. Within a day the reading with the latest
 * observed_at wins — an older, out-of-order write (e.g. a noon seed re-run
 * after a live sync) won't clobber a newer one. An existing name is preserved
 * if the new reading doesn't carry one.
 */
export function recordPlaylistObservation(
  db: Database,
  input: PlaylistObservationInput,
): void {
  db.prepare(
    `
    INSERT INTO spotify_playlist_observations
      (playlist_id, observed_date, observed_at, follower_count, name, origin, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(playlist_id, observed_date) DO UPDATE SET
      observed_at    = excluded.observed_at,
      follower_count = excluded.follower_count,
      name           = COALESCE(excluded.name, spotify_playlist_observations.name),
      origin         = excluded.origin,
      raw_data       = excluded.raw_data
    WHERE excluded.observed_at >= spotify_playlist_observations.observed_at
  `,
  ).run(
    input.playlistId,
    input.observedDate,
    input.observedAt,
    input.followerCount,
    input.name ?? null,
    input.origin,
    input.rawData != null ? JSON.stringify(input.rawData) : null,
  );
}

/**
 * Backfill a name onto observations that don't have one yet (e.g. seed rows
 * imported before the playlist name was known). Only touches NULL-name rows, so
 * historically-accurate names recorded by past syncs are left intact.
 * Returns the number of rows updated.
 */
export function fillMissingPlaylistName(
  db: Database,
  playlistId: string,
  name: string,
): number {
  const result = db
    .prepare(
      `UPDATE spotify_playlist_observations
       SET name = ?
       WHERE playlist_id = ? AND name IS NULL`,
    )
    .run(name, playlistId);
  return result.changes;
}

/** All observations for a playlist, oldest first (ready to chart). */
export function getPlaylistObservations(
  db: Database,
  playlistId: string,
): PlaylistObservation[] {
  return db
    .prepare(
      `SELECT * FROM spotify_playlist_observations
       WHERE playlist_id = ?
       ORDER BY observed_date ASC`,
    )
    .all(playlistId) as PlaylistObservation[];
}

/** Summary row per tracked playlist (latest count, span, total observations). */
export function getTrackedPlaylists(db: Database): TrackedPlaylist[] {
  return db
    .prepare(
      `SELECT
         o1.playlist_id    AS playlist_id,
         o1.name           AS name,
         o1.follower_count AS latest_count,
         o1.observed_date  AS latest_date,
         (SELECT MIN(observed_date) FROM spotify_playlist_observations o2
            WHERE o2.playlist_id = o1.playlist_id) AS first_date,
         (SELECT COUNT(*) FROM spotify_playlist_observations o3
            WHERE o3.playlist_id = o1.playlist_id) AS observations,
         m.created_at AS created_at
       FROM spotify_playlist_observations o1
       LEFT JOIN spotify_playlist_meta m ON m.playlist_id = o1.playlist_id
       WHERE o1.observed_date = (
         SELECT MAX(observed_date) FROM spotify_playlist_observations o4
         WHERE o4.playlist_id = o1.playlist_id
       )
       ORDER BY latest_count DESC`,
    )
    .all() as TrackedPlaylist[];
}

/** Read a playlist's cached metadata (creation proxy + last-checked), if any. */
export function getPlaylistMeta(
  db: Database,
  playlistId: string,
): PlaylistMeta | null {
  return (
    (db
      .prepare(
        `SELECT playlist_id, created_at, checked_at
         FROM spotify_playlist_meta WHERE playlist_id = ?`,
      )
      .get(playlistId) as PlaylistMeta | null) ?? null
  );
}

/**
 * Upsert a playlist's creation-date proxy. `createdAt` is the earliest track
 * added_at we found (or null if none qualified). The stored value only ever
 * moves *earlier*: a later reading (e.g. after the oldest track was removed)
 * won't push a known creation date forward, since creation can't un-happen.
 * `checkedAt` always advances so the sync can throttle re-computation.
 */
export function recordPlaylistCreatedAt(
  db: Database,
  input: { playlistId: string; createdAt: string | null; checkedAt: string },
): void {
  db.prepare(
    `
    INSERT INTO spotify_playlist_meta (playlist_id, created_at, checked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(playlist_id) DO UPDATE SET
      created_at = CASE
        WHEN excluded.created_at IS NULL THEN spotify_playlist_meta.created_at
        WHEN spotify_playlist_meta.created_at IS NULL THEN excluded.created_at
        WHEN excluded.created_at < spotify_playlist_meta.created_at
          THEN excluded.created_at
        ELSE spotify_playlist_meta.created_at
      END,
      checked_at = excluded.checked_at
  `,
  ).run(input.playlistId, input.createdAt, input.checkedAt);
}
