import type { TimelineEvent } from "./types";

/**
 * Parse raw_data JSON and extract album art URL + track URI in a single parse.
 * Resolution preference: 300px → 64px → first (keep in sync with src/parsers/spotify-api.ts)
 */
function parseSpotifyRawData(rawData: string): { artUrl: string | null; trackUri: string | null } {
  try {
    const data = JSON.parse(rawData);

    // Art URL: Spotify API format (track.album.images[])
    let artUrl: string | null = null;
    const images = data?.track?.album?.images;
    if (Array.isArray(images) && images.length > 0) {
      artUrl = images.find((img: { height: number }) => img.height === 300)?.url
        ?? images.find((img: { height: number }) => img.height === 64)?.url
        ?? images[0]?.url
        ?? null;
    } else if (data?.track?.imageUrl) {
      // Art URL: Spotify Friends format (track.imageUrl)
      artUrl = data.track.imageUrl;
    }

    // Track URI: API format or file export format
    const trackUri: string | null = data?.track?.uri ?? data?.spotify_track_uri ?? null;

    return { artUrl, trackUri };
  } catch {
    return { artUrl: null, trackUri: null };
  }
}

/**
 * Extract album art URL from an event's raw_data.
 *
 * Handles three formats:
 * - Spotify API: raw_data.track.album.images[] (640/300/64px)
 * - Spotify Friends: raw_data.track.imageUrl (single URL)
 * - Spotify file exports: no images available
 */
export function getAlbumArtUrl(rawData: string): string | null {
  return parseSpotifyRawData(rawData).artUrl;
}

/**
 * Extract Spotify track URI from raw_data for cache lookups.
 */
export function getTrackUri(rawData: string): string | null {
  return parseSpotifyRawData(rawData).trackUri;
}

/**
 * Get album art URL for an event, using raw_data first, then falling back to a cached image map.
 */
export function getEventAlbumArt(
  event: TimelineEvent,
  imageMap?: Map<string, string>
): string | null {
  const { artUrl, trackUri } = parseSpotifyRawData(event.raw_data);
  if (artUrl) return artUrl;

  // Fall back to cached image map by track URI
  if (imageMap && trackUri) {
    return imageMap.get(trackUri) ?? null;
  }

  return null;
}

/**
 * Extract unique album art URLs from a group of events.
 * Deduplicates by URL. Returns up to maxCount URLs.
 */
export function getSessionAlbumArts(
  events: TimelineEvent[],
  maxCount = 4,
  imageMap?: Map<string, string>
): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const event of events) {
    if (urls.length >= maxCount) break;
    const url = getEventAlbumArt(event, imageMap);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

/**
 * Check if an event is from a Spotify source that might have album art.
 */
export function isSpotifyEvent(event: TimelineEvent): boolean {
  return event.source === "spotify" || event.source === "spotify-friends";
}
