export const MUSIC_PERIODS = ["4w", "6m", "12m", "all"] as const;
export type MusicPeriod = (typeof MUSIC_PERIODS)[number];

export interface MusicRankedTrack {
  rank: number;
  trackName: string;
  artistName: string | null;
  albumName: string | null;
  trackUri: string | null;
  imageUrl: string | null;
  playCount: number;
  listeningMs: number;
  lastPlayedAt: string;
  eventId: number;
}

export interface MusicRankedArtist {
  rank: number;
  artistName: string;
  playCount: number;
  listeningMs: number;
  lastPlayedAt: string;
  latestTrackName: string | null;
  latestTrackUri: string | null;
  imageUrl: string | null;
  eventId: number;
}

export interface MusicRecentPlay {
  eventId: number;
  timestamp: string;
  trackName: string;
  artistName: string | null;
  albumName: string | null;
  trackUri: string | null;
  imageUrl: string | null;
  /** Set only when the play's stored data records the playlist it was played from. */
  playlistUri: string | null;
  playlistName: string | null;
}

export interface MusicRecentResponse {
  recent: MusicRecentPlay[];
}

export const MUSIC_EXCLUSION_KINDS = ["track", "album", "artist", "playlist"] as const;
export type MusicExclusionKind = (typeof MUSIC_EXCLUSION_KINDS)[number];

/** Something whose plays the top lists leave out. */
export interface MusicExclusion {
  id: number;
  kind: MusicExclusionKind;
  label: string;
}

/** What the top lists leave out; the Plays total and span still count everything. */
export interface MusicTopListFilter {
  exclusions: MusicExclusion[];
  excludePrivateSessions: boolean;
}

/**
 * Exclude what a play was of: its track, its album, or the playlist it was
 * played from. Artists come from the artist list, which names them.
 */
export type MusicExclusionRequest =
  | { kind: "track" | "album" | "playlist"; eventId: number }
  | { kind: "artist"; artistName: string };

export interface MusicRankingsOverview {
  period: MusicPeriod;
  periodStart: string | null;
  totalPlays: number;
  listeningMs: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  topTracks: MusicRankedTrack[];
  topArtists: MusicRankedArtist[];
  filter: MusicTopListFilter;
}
