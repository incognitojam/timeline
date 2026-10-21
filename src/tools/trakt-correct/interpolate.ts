import { getEpisode, type TraktEpisodeExtended } from "../../parsers/trakt-api";
import { type EpisodeData, type Outlier, getShowEpisodes } from "./detect";

export interface InterpolationResult {
  outlier: Outlier;
  suggestedTimestamp: string | null;
  reason: string;
  priorEpisode?: { title: string; timestamp: string; season: number; episode: number };
  followingEpisode?: { title: string; timestamp: string; season: number; episode: number };
  gapDays?: number;
  airDate?: string;
}

const MAX_GAP_DAYS = 16;

/**
 * Calculate the suggested timestamp for an outlier episode.
 *
 * Strategy:
 * 1. Get all episodes for the show
 * 2. Find the prior and following episodes that have "normal" timestamps
 * 3. Interpolate linearly between them
 * 4. Ensure the result is >= episode air date
 * 5. Only suggest if gap is <= 16 days
 */
export async function interpolateTimestamp(
  outlier: Outlier
): Promise<InterpolationResult> {
  const showEpisodes = getShowEpisodes(outlier.show_slug);

  // Find this episode's position in the show
  const episodeIndex = showEpisodes.findIndex(
    (e) => e.season === outlier.season && e.episode === outlier.episode
  );

  if (episodeIndex === -1) {
    return {
      outlier,
      suggestedTimestamp: null,
      reason: "Episode not found in show data",
    };
  }

  // Find prior and following episodes with "normal" timestamps
  // "Normal" = watched BEFORE the next episode and AFTER the previous episode
  let priorEpisode: EpisodeData | null = null;
  let followingEpisode: EpisodeData | null = null;

  // Look backwards for prior episode
  for (let i = episodeIndex - 1; i >= 0; i--) {
    const candidate = showEpisodes[i];
    // Check this episode was watched before the one after it
    if (i + 1 < showEpisodes.length) {
      const next = showEpisodes[i + 1];
      if (new Date(candidate.timestamp) <= new Date(next.timestamp)) {
        priorEpisode = candidate;
        break;
      }
    } else {
      // No next episode to compare, accept it
      priorEpisode = candidate;
      break;
    }
  }

  // Look forwards for following episode
  for (let i = episodeIndex + 1; i < showEpisodes.length; i++) {
    const candidate = showEpisodes[i];
    // Check this episode was watched after the one before it
    if (i - 1 >= 0) {
      const prev = showEpisodes[i - 1];
      if (new Date(candidate.timestamp) >= new Date(prev.timestamp)) {
        followingEpisode = candidate;
        break;
      }
    } else {
      followingEpisode = candidate;
      break;
    }
  }

  // If we can't find surrounding episodes, we can't interpolate
  if (!priorEpisode && !followingEpisode) {
    return {
      outlier,
      suggestedTimestamp: null,
      reason: "No surrounding episodes to interpolate from",
    };
  }

  // If only one side exists, we can't interpolate reliably
  if (!priorEpisode || !followingEpisode) {
    return {
      outlier,
      suggestedTimestamp: null,
      reason: `Only ${priorEpisode ? "prior" : "following"} episode available, cannot interpolate`,
      priorEpisode: priorEpisode
        ? {
            title: priorEpisode.title,
            timestamp: priorEpisode.timestamp,
            season: priorEpisode.season,
            episode: priorEpisode.episode,
          }
        : undefined,
      followingEpisode: followingEpisode
        ? {
            title: followingEpisode.title,
            timestamp: followingEpisode.timestamp,
            season: followingEpisode.season,
            episode: followingEpisode.episode,
          }
        : undefined,
    };
  }

  // Calculate the gap (after null check, TypeScript knows both episodes exist)
  const priorTime = new Date(priorEpisode.timestamp);
  const followingTime = new Date(followingEpisode.timestamp);

  // Calculate gap in days
  const gapMs = followingTime.getTime() - priorTime.getTime();
  const gapDays = gapMs / (1000 * 60 * 60 * 24);

  if (gapDays > MAX_GAP_DAYS) {
    return {
      outlier,
      suggestedTimestamp: null,
      reason: `Gap too large: ${gapDays.toFixed(1)} days (max: ${MAX_GAP_DAYS})`,
      priorEpisode: {
        title: priorEpisode.title,
        timestamp: priorEpisode.timestamp,
        season: priorEpisode.season,
        episode: priorEpisode.episode,
      },
      followingEpisode: {
        title: followingEpisode.title,
        timestamp: followingEpisode.timestamp,
        season: followingEpisode.season,
        episode: followingEpisode.episode,
      },
      gapDays,
    };
  }

  // Calculate how many episodes are between prior and following (including the outlier)
  const episodesBetween =
    (followingEpisode.season - priorEpisode.season) * 100 +
    (followingEpisode.episode - priorEpisode.episode);
  const outlierPosition =
    (outlier.season - priorEpisode.season) * 100 +
    (outlier.episode - priorEpisode.episode);

  // Linear interpolation
  const fraction = outlierPosition / episodesBetween;
  const interpolatedMs = priorTime.getTime() + gapMs * fraction;
  let suggestedDate = new Date(interpolatedMs);

  // Try to get episode air date to ensure we don't suggest before it aired
  let airDate: string | undefined;
  try {
    const rawData = JSON.parse(outlier.raw_data);
    const showSlug = rawData.show?.ids?.slug;
    if (showSlug) {
      const episodeDetails = await getEpisode(
        showSlug,
        outlier.season,
        outlier.episode
      );
      if (episodeDetails.first_aired) {
        airDate = episodeDetails.first_aired;
        const airDateTime = new Date(episodeDetails.first_aired);
        if (suggestedDate < airDateTime) {
          suggestedDate = airDateTime;
        }
      }
    }
  } catch (e) {
    // Couldn't fetch air date, continue without it
  }

  return {
    outlier,
    suggestedTimestamp: suggestedDate.toISOString(),
    reason: "Interpolated from surrounding episodes",
    priorEpisode: {
      title: priorEpisode.title,
      timestamp: priorEpisode.timestamp,
      season: priorEpisode.season,
      episode: priorEpisode.episode,
    },
    followingEpisode: {
      title: followingEpisode.title,
      timestamp: followingEpisode.timestamp,
      season: followingEpisode.season,
      episode: followingEpisode.episode,
    },
    gapDays,
    airDate,
  };
}

/**
 * Process multiple outliers and return interpolation results.
 */
export async function interpolateAll(
  outliers: Outlier[]
): Promise<InterpolationResult[]> {
  const results: InterpolationResult[] = [];

  for (const outlier of outliers) {
    const result = await interpolateTimestamp(outlier);
    results.push(result);
  }

  return results;
}
