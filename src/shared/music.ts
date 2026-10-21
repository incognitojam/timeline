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
}

export interface MusicRecentResponse {
  recent: MusicRecentPlay[];
}

export interface MusicRankingsOverview {
  period: MusicPeriod;
  periodStart: string | null;
  totalPlays: number;
  listeningMs: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  topTracks: MusicRankedTrack[];
  topArtists: MusicRankedArtist[];
}
