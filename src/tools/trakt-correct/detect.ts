import { getDb } from "../../db/schema";

export interface EpisodeData {
  id: number;
  source_id: string;
  title: string;
  timestamp: string;
  show_slug: string;
  season: number;
  episode: number;
  raw_data: string;
}

export interface Outlier extends EpisodeData {
  reason: "out_of_order" | "bulk_marked";
  // For out-of-order: the episode that was watched before this one but should be after
  conflicting_episode?: {
    title: string;
    timestamp: string;
    season: number;
    episode: number;
  };
  // For bulk-marked: nearby episodes from different shows
  nearby_episodes?: {
    title: string;
    timestamp: string;
    seconds_apart: number;
  }[];
}

/**
 * Find outliers that are likely bulk-marked:
 * 1. Different shows watched within 5 minutes of each other (bulk marking)
 * 2. Same show, non-consecutive episodes all marked at the same second (filling gaps)
 *
 * This intentionally EXCLUDES legitimate rewatches (episodes watched in order but
 * at a different time than the original viewing).
 *
 * @param sinceDate - Optional: only return outliers marked since this date
 */
export function detectOutliers(sinceDate?: Date): Outlier[] {
  const db = getDb();
  const sinceTimestamp = sinceDate?.toISOString();
  const outliers: Outlier[] = [];
  const seenIds = new Set<number>();

  // PRIMARY: Detect bulk-marked clusters (different shows within 5 minutes)
  // Only flag if there are 3+ total episodes in the cluster (not just 2 shows with 1 ep each)
  const bulkQuery = db.query<
    EpisodeData & {
      nearby_title: string;
      nearby_timestamp: string;
      nearby_show_slug: string;
      seconds_apart: number;
      cluster_size: number;
    },
    [string | null]
  >(`
    WITH episode_data AS (
      SELECT
        id,
        source_id,
        title,
        timestamp,
        json_extract(raw_data, '$.show.ids.slug') as show_slug,
        CAST(json_extract(raw_data, '$.episode.season') AS INTEGER) as season,
        CAST(json_extract(raw_data, '$.episode.number') AS INTEGER) as episode,
        raw_data
      FROM events
      WHERE source = 'trakt' AND type = 'trakt:episode'
        AND (?1 IS NULL OR timestamp >= ?1)
    ),
    -- Count how many episodes are within 5 min of each episode
    cluster_counts AS (
      SELECT e1.id, COUNT(DISTINCT e2.id) as cluster_size
      FROM episode_data e1
      INNER JOIN episode_data e2 ON e2.id != e1.id
        AND ABS(julianday(e2.timestamp) - julianday(e1.timestamp)) * 86400 < 300
      GROUP BY e1.id
      HAVING cluster_size >= 2  -- At least 3 episodes total (this one + 2 others)
    )
    SELECT
      e1.id, e1.source_id, e1.title, e1.timestamp, e1.show_slug, e1.season, e1.episode, e1.raw_data,
      e2.title as nearby_title,
      e2.timestamp as nearby_timestamp,
      e2.show_slug as nearby_show_slug,
      ABS(CAST((julianday(e2.timestamp) - julianday(e1.timestamp)) * 86400 AS INTEGER)) as seconds_apart,
      c.cluster_size
    FROM episode_data e1
    INNER JOIN cluster_counts c ON c.id = e1.id
    INNER JOIN episode_data e2 ON e2.id != e1.id
      AND e2.show_slug != e1.show_slug
      AND ABS(julianday(e2.timestamp) - julianday(e1.timestamp)) * 86400 < 300
    ORDER BY e1.timestamp DESC, seconds_apart ASC
  `);

  const bulkResults = bulkQuery.all(sinceTimestamp ?? null);

  // Group by episode ID to collect all nearby episodes from different shows
  const bulkByEpisode = new Map<
    number,
    {
      episode: EpisodeData;
      nearby: { title: string; timestamp: string; seconds_apart: number }[];
    }
  >();

  for (const row of bulkResults) {
    let entry = bulkByEpisode.get(row.id);
    if (!entry) {
      entry = {
        episode: {
          id: row.id,
          source_id: row.source_id,
          title: row.title,
          timestamp: row.timestamp,
          show_slug: row.show_slug,
          season: row.season,
          episode: row.episode,
          raw_data: row.raw_data,
        },
        nearby: [],
      };
      bulkByEpisode.set(row.id, entry);
    }

    entry.nearby.push({
      title: row.nearby_title,
      timestamp: row.nearby_timestamp,
      seconds_apart: row.seconds_apart,
    });
  }

  // Add bulk-marked outliers
  for (const [id, data] of bulkByEpisode) {
    if (data.nearby.length >= 1) {
      seenIds.add(id);
      outliers.push({
        ...data.episode,
        reason: "bulk_marked",
        nearby_episodes: data.nearby.slice(0, 5),
      });
    }
  }

  // SECONDARY: Detect "impossible viewing" - multiple consecutive episodes of same show
  // marked at the exact same second (can't watch 10 episodes in 1 second!)
  const impossibleViewingQuery = db.query<
    EpisodeData & { episodes_same_second: number },
    [string | null]
  >(`
    WITH episode_data AS (
      SELECT
        id,
        source_id,
        title,
        timestamp,
        json_extract(raw_data, '$.show.ids.slug') as show_slug,
        CAST(json_extract(raw_data, '$.episode.season') AS INTEGER) as season,
        CAST(json_extract(raw_data, '$.episode.number') AS INTEGER) as episode,
        raw_data
      FROM events
      WHERE source = 'trakt' AND type = 'trakt:episode'
        AND (?1 IS NULL OR timestamp >= ?1)
    ),
    same_second_counts AS (
      SELECT show_slug, timestamp, COUNT(*) as cnt
      FROM episode_data
      GROUP BY show_slug, timestamp
      HAVING cnt >= 3  -- 3+ episodes at exact same second is suspicious
    )
    SELECT
      e.id, e.source_id, e.title, e.timestamp, e.show_slug, e.season, e.episode, e.raw_data,
      s.cnt as episodes_same_second
    FROM episode_data e
    INNER JOIN same_second_counts s ON s.show_slug = e.show_slug AND s.timestamp = e.timestamp
    ORDER BY e.timestamp DESC, e.show_slug, e.season, e.episode
  `);

  const impossibleResults = impossibleViewingQuery.all(sinceTimestamp ?? null);

  for (const row of impossibleResults) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);

    outliers.push({
      id: row.id,
      source_id: row.source_id,
      title: row.title,
      timestamp: row.timestamp,
      show_slug: row.show_slug,
      season: row.season,
      episode: row.episode,
      raw_data: row.raw_data,
      reason: "bulk_marked",
      nearby_episodes: [
        {
          title: `${row.episodes_same_second} episodes marked at exact same second`,
          timestamp: row.timestamp,
          seconds_apart: 0,
        },
      ],
    });
  }

  // TERTIARY: Detect out-of-order episodes that were marked at the SAME SECOND
  // as other episodes of the same show (indicating gap-filling, not rewatching)
  const sameSecondOutOfOrderQuery = db.query<
    EpisodeData & {
      conflict_title: string;
      conflict_timestamp: string;
      conflict_season: number;
      conflict_episode: number;
    },
    [string | null]
  >(`
    WITH episode_data AS (
      SELECT
        id,
        source_id,
        title,
        timestamp,
        json_extract(raw_data, '$.show.ids.slug') as show_slug,
        CAST(json_extract(raw_data, '$.episode.season') AS INTEGER) as season,
        CAST(json_extract(raw_data, '$.episode.number') AS INTEGER) as episode,
        raw_data
      FROM events
      WHERE source = 'trakt' AND type = 'trakt:episode'
        AND (?1 IS NULL OR timestamp >= ?1)
    )
    SELECT DISTINCT
      e1.id, e1.source_id, e1.title, e1.timestamp, e1.show_slug, e1.season, e1.episode, e1.raw_data,
      e2.title as conflict_title,
      e2.timestamp as conflict_timestamp,
      e2.season as conflict_season,
      e2.episode as conflict_episode
    FROM episode_data e1
    INNER JOIN episode_data e2 ON e2.show_slug = e1.show_slug
      AND e2.id != e1.id
      -- e2 is a LATER episode that was watched EARLIER (before e1)
      AND (e2.season > e1.season OR (e2.season = e1.season AND e2.episode > e1.episode))
      AND e2.timestamp < e1.timestamp
    -- Only flag if there are multiple episodes of this show marked within 60 seconds
    -- (indicates bulk marking, not regular viewing)
    WHERE EXISTS (
      SELECT 1 FROM episode_data e3
      WHERE e3.show_slug = e1.show_slug
        AND e3.id != e1.id
        AND ABS(julianday(e3.timestamp) - julianday(e1.timestamp)) * 86400 < 60
    )
    ORDER BY e1.timestamp DESC
  `);

  const outOfOrderResults = sameSecondOutOfOrderQuery.all(sinceTimestamp ?? null);

  for (const row of outOfOrderResults) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);

    outliers.push({
      id: row.id,
      source_id: row.source_id,
      title: row.title,
      timestamp: row.timestamp,
      show_slug: row.show_slug,
      season: row.season,
      episode: row.episode,
      raw_data: row.raw_data,
      reason: "out_of_order",
      conflicting_episode: {
        title: row.conflict_title,
        timestamp: row.conflict_timestamp,
        season: row.conflict_season,
        episode: row.conflict_episode,
      },
    });
  }

  db.close();

  return outliers;
}

/**
 * Get all episodes for a given show, ordered by season/episode number.
 */
export function getShowEpisodes(showSlug: string): EpisodeData[] {
  const db = getDb();

  const query = db.query<EpisodeData, [string]>(`
    SELECT
      id,
      source_id,
      title,
      timestamp,
      json_extract(raw_data, '$.show.ids.slug') as show_slug,
      CAST(json_extract(raw_data, '$.episode.season') AS INTEGER) as season,
      CAST(json_extract(raw_data, '$.episode.number') AS INTEGER) as episode,
      raw_data
    FROM events
    WHERE source = 'trakt'
      AND type = 'trakt:episode'
      AND json_extract(raw_data, '$.show.ids.slug') = ?
    ORDER BY season, episode
  `);

  const results = query.all(showSlug);
  db.close();

  return results;
}

export interface SequenceInfo {
  isInSequence: boolean;
  prevEpisode?: { season: number; episode: number; timestamp: string; gapMinutes: number };
  nextEpisode?: { season: number; episode: number; timestamp: string; gapMinutes: number };
  reason: string;
}

const MIN_GAP_MINUTES = 20; // Minimum time between episodes to consider "in sequence"

/**
 * Check if a specific viewing (by timestamp) of an episode appears to be "in sequence"
 * - Was watched after the previous episode (with reasonable gap)
 * - Was watched before the next episode (with reasonable gap)
 */
export function checkSequence(
  showSlug: string,
  season: number,
  episode: number,
  viewingTimestamp: string
): SequenceInfo {
  const allEpisodes = getShowEpisodes(showSlug);
  const viewingTime = new Date(viewingTimestamp).getTime();

  // Find the previous and next episodes by season/episode number
  let prevEp: EpisodeData | undefined;
  let nextEp: EpisodeData | undefined;

  for (const ep of allEpisodes) {
    const isBefore = ep.season < season || (ep.season === season && ep.episode < episode);
    const isAfter = ep.season > season || (ep.season === season && ep.episode > episode);

    if (isBefore) {
      // Keep the latest "before" episode
      if (!prevEp || ep.season > prevEp.season || (ep.season === prevEp.season && ep.episode > prevEp.episode)) {
        prevEp = ep;
      }
    }
    if (isAfter) {
      // Keep the earliest "after" episode
      if (!nextEp || ep.season < nextEp.season || (ep.season === nextEp.season && ep.episode < nextEp.episode)) {
        nextEp = ep;
      }
    }
  }

  // Check sequence
  let prevOk = false;
  let nextOk = false;
  let prevGapMinutes = 0;
  let nextGapMinutes = 0;

  if (prevEp) {
    const prevTime = new Date(prevEp.timestamp).getTime();
    prevGapMinutes = (viewingTime - prevTime) / (1000 * 60);
    // Previous episode should have been watched BEFORE this one, with at least MIN_GAP_MINUTES
    prevOk = prevGapMinutes >= MIN_GAP_MINUTES;
  }

  if (nextEp) {
    const nextTime = new Date(nextEp.timestamp).getTime();
    nextGapMinutes = (nextTime - viewingTime) / (1000 * 60);
    // Next episode should have been watched AFTER this one, with at least MIN_GAP_MINUTES
    nextOk = nextGapMinutes >= MIN_GAP_MINUTES;
  }

  const isInSequence = (prevEp ? prevOk : true) && (nextEp ? nextOk : true) && !!(prevEp || nextEp);

  let reason: string;
  if (isInSequence) {
    const parts: string[] = [];
    if (prevEp && prevOk) {
      parts.push(`${Math.round(prevGapMinutes / 60)}h after prev`);
    }
    if (nextEp && nextOk) {
      parts.push(`${Math.round(nextGapMinutes / 60)}h before next`);
    }
    reason = `In sequence (${parts.join(", ")})`;
  } else {
    if (prevEp && !prevOk && prevGapMinutes < MIN_GAP_MINUTES && prevGapMinutes > 0) {
      reason = `Too close to prev episode (${Math.round(prevGapMinutes)}min)`;
    } else if (nextEp && !nextOk && nextGapMinutes < MIN_GAP_MINUTES && nextGapMinutes > 0) {
      reason = `Too close to next episode (${Math.round(nextGapMinutes)}min)`;
    } else if (prevEp && prevGapMinutes < 0) {
      reason = `Watched BEFORE previous episode`;
    } else if (nextEp && nextGapMinutes < 0) {
      reason = `Watched AFTER next episode`;
    } else if (!prevEp && !nextEp) {
      reason = `No surrounding episodes to check`;
    } else {
      reason = `Not in sequence`;
    }
  }

  return {
    isInSequence,
    prevEpisode: prevEp ? {
      season: prevEp.season,
      episode: prevEp.episode,
      timestamp: prevEp.timestamp,
      gapMinutes: prevGapMinutes,
    } : undefined,
    nextEpisode: nextEp ? {
      season: nextEp.season,
      episode: nextEp.episode,
      timestamp: nextEp.timestamp,
      gapMinutes: nextGapMinutes,
    } : undefined,
    reason,
  };
}

/**
 * Get movie outliers (movies marked in bulk clusters)
 */
export function detectMovieOutliers(): {
  id: number;
  source_id: string;
  title: string;
  timestamp: string;
  nearby_titles: string[];
}[] {
  const db = getDb();

  const query = db.query<
    {
      id: number;
      source_id: string;
      title: string;
      timestamp: string;
      nearby_title: string;
      seconds_apart: number;
    },
    []
  >(`
    WITH movie_data AS (
      SELECT id, source_id, title, timestamp
      FROM events
      WHERE source = 'trakt' AND type = 'trakt:movie'
    ),
    episode_data AS (
      SELECT id, title, timestamp
      FROM events
      WHERE source = 'trakt' AND type = 'trakt:episode'
    )
    SELECT
      m.id, m.source_id, m.title, m.timestamp,
      e.title as nearby_title,
      ABS(CAST((julianday(e.timestamp) - julianday(m.timestamp)) * 86400 AS INTEGER)) as seconds_apart
    FROM movie_data m
    INNER JOIN episode_data e ON ABS(julianday(e.timestamp) - julianday(m.timestamp)) * 86400 < 300
    ORDER BY m.timestamp DESC
  `);

  const results = query.all();
  db.close();

  // Group by movie
  const movieMap = new Map<
    number,
    { id: number; source_id: string; title: string; timestamp: string; nearby_titles: string[] }
  >();

  for (const row of results) {
    let entry = movieMap.get(row.id);
    if (!entry) {
      entry = {
        id: row.id,
        source_id: row.source_id,
        title: row.title,
        timestamp: row.timestamp,
        nearby_titles: [],
      };
      movieMap.set(row.id, entry);
    }
    entry.nearby_titles.push(row.nearby_title);
  }

  return Array.from(movieMap.values());
}
