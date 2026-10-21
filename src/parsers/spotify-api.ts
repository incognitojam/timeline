#!/usr/bin/env bun
/**
 * Spotify API Parser
 *
 * Syncs recently played tracks via Spotify Web API.
 *
 * Setup:
 * 1. Create an app at https://developer.spotify.com/dashboard
 * 2. Add redirect URI: http://127.0.0.1:8742/callback
 * 3. Create ~/.config/timeline/spotify.json with client_id (and optional client_secret)
 * 4. Run: bun run src/parsers/spotify-api.ts auth
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";
import { deleteSyncState, getAppStateDb, getSyncState, setSyncState, getAllSpotifyResources, setSpotifyResource } from "../db/app-state";
import { createTokenManager, type OAuthTokens } from "../lib/oauth-tokens";
import {
  createOAuth2Client,
  type OAuth2ProviderConfig,
  type OAuth2TokenResponse,
} from "../lib/oauth2-client";
import { sanitizeAccountName } from "../lib/account";

// ============================================================================
// Types
// ============================================================================

export interface SpotifyConfig {
  client_id: string;
  client_secret?: string;
}

export interface SpotifyTokens extends OAuthTokens {
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  account_name?: string;  // Auto-detected from /v1/me on first auth
}

interface SpotifyArtist {
  name: string;
}

interface SpotifyAlbum {
  name: string;
  images?: { url: string; height: number; width: number }[];
}

interface SpotifyTrack {
  uri: string;
  name: string;
  artists: SpotifyArtist[];
  album?: SpotifyAlbum;
}

interface SpotifyContext {
  type: string;
  uri: string;
  href: string;
}

export interface SpotifyPlayHistoryItem {
  track: SpotifyTrack | null;
  played_at: string;
  context?: SpotifyContext | null;
}

interface SpotifyRecentlyPlayedResponse {
  items: SpotifyPlayHistoryItem[];
  next: string | null;
  cursors?: {
    after?: string;
    before?: string;
  };
  limit: number;
}

interface SpotifyUserProfile {
  id: string;
  display_name?: string;
  email?: string;
}

interface SpotifySyncState {
  lastPlayedAtMs?: number;
  lastPlayedAt?: string;
}

interface SpotifyPlaylistResponse {
  id: string;
  name: string;
  owner: { display_name: string };
}

export interface SpotifySyncStats {
  imported: number;
  skipped: number;
  apiRecords: number;
}

// ============================================================================
// Config + Token Storage
// ============================================================================

const CONFIG_DIR = join(homedir(), ".config", "timeline");
export const SPOTIFY_CONFIG_PATH = join(CONFIG_DIR, "spotify.json");
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const SCOPES = ["user-read-recently-played", "user-read-private"];
const SYNC_STATE_KEY = "spotify-sync";
const PLAYLIST_MISSING_STATE_KEY = "spotify-playlist-missing";
const PLAYLIST_MISSING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type MissingPlaylistCache = Record<string, number>;

const SPOTIFY_OAUTH: OAuth2ProviderConfig = {
  name: "Spotify",
  authUrl: "https://accounts.spotify.com/authorize",
  tokenUrl: "https://accounts.spotify.com/api/token",
  scopes: SCOPES,
  authMethod: "basic", // Uses Basic Auth when client_secret is present
  contentType: "form",
  pkce: true, // Always use PKCE for security (works with or without client_secret)
};

export function loadSpotifyConfig(): SpotifyConfig | null {
  if (existsSync(SPOTIFY_CONFIG_PATH)) {
    try {
      const saved = JSON.parse(readFileSync(SPOTIFY_CONFIG_PATH, "utf-8"));
      if (saved.client_id) {
        return {
          client_id: saved.client_id,
          client_secret: saved.client_secret,
        };
      }
    } catch {
      // Fall back to environment variables if config is malformed
    }
  }

  const client_id = process.env.SPOTIFY_CLIENT_ID;
  if (!client_id) return null;

  return {
    client_id,
    client_secret: process.env.SPOTIFY_CLIENT_SECRET,
  };
}

function requireSpotifyConfig(): SpotifyConfig {
  const config = loadSpotifyConfig();
  if (!config) {
    throw new Error(
      "Spotify credentials required. Create ~/.config/timeline/spotify.json with client_id (and optional client_secret) " +
        "or set SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET environment variables."
    );
  }
  return config;
}

// Token manager for direct access (reset command, status check)
const tokenManager = createTokenManager<SpotifyTokens>("spotify");

// Token extractor preserves Spotify-specific fields
export function spotifyTokenExtractor(
  response: OAuth2TokenResponse,
  previousTokens?: SpotifyTokens,
): SpotifyTokens {
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token ?? previousTokens?.refresh_token,
    expires_at: Date.now() + response.expires_in * 1000,
    scope: response.scope,
    token_type: response.token_type as string | undefined,
    account_name: previousTokens?.account_name,
  };
}

function createSpotifyOAuthClient(config: SpotifyConfig) {
  return createOAuth2Client<SpotifyTokens>({
    provider: SPOTIFY_OAUTH,
    credentials: {
      clientId: config.client_id,
      clientSecret: config.client_secret,
    },
    stateKey: "spotify",
    tokenExtractor: spotifyTokenExtractor,
  });
}

// ============================================================================
// API Helpers
// ============================================================================

export class SpotifyApiError extends Error {
  status: number;
  retryAfter?: number;

  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function spotifyGet<T>(
  tokens: SpotifyTokens,
  endpoint: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(`${SPOTIFY_API_URL}${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfter = retryAfterHeader
      ? Number.parseInt(retryAfterHeader, 10)
      : undefined;
    const suffix = Number.isFinite(retryAfter) ? ` Retry after ${retryAfter}s.` : "";
    throw new SpotifyApiError(429, `Spotify rate limited.${suffix}`, retryAfter);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new SpotifyApiError(
      response.status,
      `Spotify API error ${response.status}: ${error}`
    );
  }

  return response.json();
}

async function fetchRecentlyPlayed(
  tokens: SpotifyTokens,
  afterMs?: number
): Promise<SpotifyRecentlyPlayedResponse> {
  const params: Record<string, string> = { limit: "50" };
  if (afterMs) {
    params.after = String(afterMs);
  }
  return spotifyGet<SpotifyRecentlyPlayedResponse>(
    tokens,
    "/me/player/recently-played",
    params
  );
}

async function fetchUserProfile(tokens: SpotifyTokens): Promise<SpotifyUserProfile> {
  return spotifyGet<SpotifyUserProfile>(tokens, "/me");
}

/**
 * Fetch playlist name from Spotify API.
 * Returns null on 404/403 (deleted/private); throws on rate limit.
 */
export async function fetchPlaylistName(
  tokens: SpotifyTokens,
  playlistId: string
): Promise<string | null> {
  try {
    const data = await spotifyGet<SpotifyPlaylistResponse>(
      tokens,
      `/playlists/${playlistId}`,
      { fields: "id,name,owner" }
    );
    return data.name;
  } catch (error) {
    if (error instanceof SpotifyApiError) {
      if (error.status === 404 || error.status === 403) {
        return null;
      }
      if (error.status === 429) {
        throw error;
      }
    }
    throw error;
  }
}

export interface SpotifyPlaylistFollowers {
  id: string;
  name: string;
  /** followers.total - the public "saves"/likes count shown in the Spotify UI. */
  followerCount: number;
  ownerName: string | null;
  /** Cover-art URL (≈300px preferred), or null when the playlist has no image. */
  imageUrl: string | null;
}

/**
 * Fetch a playlist's follower count (the public "saves"/likes number).
 * Returns null on 404/403 (deleted/private); rethrows rate-limit (429) and
 * other errors so callers can stop gracefully.
 */
export async function fetchPlaylistFollowers(
  tokens: SpotifyTokens,
  playlistId: string,
): Promise<SpotifyPlaylistFollowers | null> {
  try {
    const data = await spotifyGet<{
      id: string;
      name: string;
      followers?: { total?: number } | null;
      owner?: { display_name?: string };
      images?: { url: string; height: number | null }[] | null;
    }>(tokens, `/playlists/${playlistId}`, {
      fields: "id,name,followers.total,owner.display_name,images",
    });
    // Cover-art preference: ≈300px, then ≈64px, then the first available.
    // Auto-generated mosaic covers arrive as a single null-height image, which
    // the final fallback catches. (Keep in sync with web/src/lib/spotify-art.ts.)
    const images = data.images;
    const imageUrl =
      images?.find((img) => img.height === 300)?.url ??
      images?.find((img) => img.height === 64)?.url ??
      images?.[0]?.url ??
      null;
    return {
      id: data.id,
      name: data.name,
      followerCount: data.followers?.total ?? 0,
      ownerName: data.owner?.display_name ?? null,
      imageUrl,
    };
  } catch (error) {
    if (
      error instanceof SpotifyApiError &&
      (error.status === 404 || error.status === 403)
    ) {
      return null;
    }
    throw error;
  }
}

// Spotify launched October 2008; any added_at before then is a bogus/default
// value (e.g. local files, or very old additions that predate the field).
const SPOTIFY_LAUNCH_MS = Date.parse("2008-10-07T00:00:00Z");

/**
 * Pick the earliest valid `added_at` from a playlist's track items. Null/empty
 * and pre-launch timestamps are discarded; returns null if none qualify. This
 * is the creation-date proxy used by `fetchPlaylistCreatedAt` (kept pure so the
 * filtering/min logic is unit-testable without the network).
 */
export function earliestValidAddedAt(
  addedAts: (string | null | undefined)[],
): string | null {
  let earliest: string | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const added of addedAts) {
    if (!added) continue;
    const ms = Date.parse(added);
    if (!Number.isFinite(ms) || ms < SPOTIFY_LAUNCH_MS) continue;
    if (ms < earliestMs) {
      earliest = added;
      earliestMs = ms;
    }
  }
  return earliest;
}

/**
 * Approximate a playlist's creation date as the earliest track `added_at`.
 * Spotify's API exposes no creation field, so this pages through all items
 * (cheaply: only the added_at field) and returns the oldest valid one.
 * Returns null on 404/403 (deleted/private) or when no track has a usable
 * added_at; rethrows rate-limit (429) so callers can stop gracefully.
 */
export async function fetchPlaylistCreatedAt(
  tokens: SpotifyTokens,
  playlistId: string,
): Promise<string | null> {
  const limit = 100;
  const addedAts: (string | null)[] = [];
  try {
    for (let offset = 0; ; offset += limit) {
      const page = await spotifyGet<{
        total: number;
        items: { added_at: string | null }[];
      }>(tokens, `/playlists/${playlistId}/tracks`, {
        fields: "total,items(added_at)",
        limit: String(limit),
        offset: String(offset),
      });
      for (const item of page.items) addedAts.push(item.added_at);
      if (page.items.length === 0 || offset + limit >= page.total) break;
    }
    return earliestValidAddedAt(addedAts);
  } catch (error) {
    if (
      error instanceof SpotifyApiError &&
      (error.status === 404 || error.status === 403)
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Extract a Spotify playlist ID from a bare ID, a `spotify:playlist:<id>` URI,
 * or an `open.spotify.com/playlist/<id>` URL. Returns null if unrecognized.
 */
export function extractPlaylistId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];

  const uriMatch = trimmed.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uriMatch) return uriMatch[1];

  if (/^[A-Za-z0-9]+$/.test(trimmed)) return trimmed;

  return null;
}

/**
 * Collect unknown playlist URIs from API response items.
 */
export function collectUnknownPlaylistUris(
  items: SpotifyPlayHistoryItem[],
  cache: Map<string, string>,
  options: {
    missingCache?: MissingPlaylistCache;
    nowMs?: number;
    missingTtlMs?: number;
  } = {}
): string[] {
  const unknownUris = new Set<string>();
  const missingCache = options.missingCache;
  const nowMs = options.nowMs ?? Date.now();
  const missingTtlMs = options.missingTtlMs ?? PLAYLIST_MISSING_TTL_MS;

  for (const item of items) {
    const context = item.context;
    if (context?.type === "playlist" && context.uri && !cache.has(context.uri)) {
      const lastCheckedMs = missingCache?.[context.uri];
      if (
        typeof lastCheckedMs === "number" &&
        nowMs - lastCheckedMs < missingTtlMs
      ) {
        continue;
      }
      unknownUris.add(context.uri);
    }
  }

  return Array.from(unknownUris);
}

function loadMissingPlaylistCache(appDb: Database): MissingPlaylistCache {
  return getSyncState<MissingPlaylistCache>(appDb, PLAYLIST_MISSING_STATE_KEY) ?? {};
}

function saveMissingPlaylistCache(appDb: Database, cache: MissingPlaylistCache): void {
  setSyncState(appDb, PLAYLIST_MISSING_STATE_KEY, cache);
}

/**
 * Resolve playlist names and update cache.
 */
async function resolvePlaylistNames(
  tokens: SpotifyTokens,
  uris: string[],
  appDb: Database,
  cache: Map<string, string>,
  missingCache: MissingPlaylistCache,
  options: { verbose?: boolean }
): Promise<{ resolved: number; rateLimited: boolean; missingUpdated: boolean }> {
  let resolved = 0;
  let rateLimited = false;
  let missingUpdated = false;
  const checkedAtMs = Date.now();

  for (const uri of uris) {
    // Extract playlist ID from URI: spotify:playlist:0123456789ABCDEFGHIJKL
    const match = uri.match(/spotify:playlist:([a-zA-Z0-9]+)/);
    if (!match) continue;

    const playlistId = match[1];
    try {
      const name = await fetchPlaylistName(tokens, playlistId);

      if (name) {
        if (options.verbose) {
          console.log(`[spotify] Resolved playlist: ${name}`);
        }
        // Update both persistent cache and in-memory map
        setSpotifyResource(appDb, uri, "playlist", name);
        cache.set(uri, name);
        if (missingCache[uri]) {
          delete missingCache[uri];
          missingUpdated = true;
        }
        resolved++;
      } else {
        missingCache[uri] = checkedAtMs;
        missingUpdated = true;
      }
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 429) {
        rateLimited = true;
        if (options.verbose) {
          const retryAfter = Number.isFinite(error.retryAfter)
            ? ` Retry after ${error.retryAfter}s.`
            : "";
          console.log(`[spotify] Rate limited resolving playlists.${retryAfter}`);
        }
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[spotify] Failed to fetch playlist ${playlistId}: ${message}`);
    }
  }

  return { resolved, rateLimited, missingUpdated };
}

/**
 * Fetch and store the account name from the Spotify profile.
 * Uses sanitized display_name if available, otherwise falls back to user ID.
 */
async function ensureAccountName(tokens: SpotifyTokens): Promise<string> {
  if (tokens.account_name) {
    return tokens.account_name;
  }

  const profile = await fetchUserProfile(tokens);
  const accountName = profile.display_name
    ? sanitizeAccountName(profile.display_name)
    : profile.id;

  // Update stored tokens with account name
  const updatedTokens: SpotifyTokens = { ...tokens, account_name: accountName };
  tokenManager.save(updatedTokens);

  return accountName;
}

// ============================================================================
// Sync Logic
// ============================================================================

function buildContent(track: SpotifyTrack): string | null {
  if (!track.name) return null;

  const artists = track.artists?.map((a) => a.name).filter(Boolean).join(", ");
  return [
    track.name,
    artists && `by ${artists}`,
    track.album?.name && `from ${track.album.name}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildTags(
  track: SpotifyTrack,
  context?: SpotifyContext | null,
  resourceCache?: Map<string, string>
): string[] {
  const tags: string[] = ["api"];

  // Artist tags (multiple for collabs)
  for (const artist of track.artists || []) {
    if (artist.name) tags.push(`artist:${artist.name}`);
  }

  // Album tag
  if (track.album?.name) tags.push(`album:${track.album.name}`);

  // Playlist tag (from cache if available)
  if (context?.uri) {
    const cachedName = resourceCache?.get(context.uri);
    if (cachedName && context.type === "playlist") {
      tags.push(`playlist:${cachedName}`);
    }
    // album/artist context types are already covered by track metadata above
  }

  return tags;
}

async function syncSpotifyWithDb(
  db: Database,
  sourceAccount: string | undefined,
  options: { verbose?: boolean; headless?: boolean; dryRun?: boolean } = {}
): Promise<SpotifySyncStats> {
  const config = requireSpotifyConfig();
  const oauthClient = createSpotifyOAuthClient(config);
  const tokens = await oauthClient.ensureValidToken({ headless: options.headless });

  // Auto-detect account name from profile if not provided
  const accountName = sourceAccount || await ensureAccountName(tokens);
  if (options.verbose) {
    console.log(`[spotify] Using account: ${accountName}`);
  }

  const appDb = getAppStateDb();
  const syncState = getSyncState<SpotifySyncState>(appDb, SYNC_STATE_KEY);
  const afterMs = syncState?.lastPlayedAtMs;

  if (options.verbose) {
    const afterStr = afterMs ? new Date(afterMs).toISOString() : "none";
    console.log(`[spotify] Fetching recently played (after: ${afterStr})`);
  }

  const response = await fetchRecentlyPlayed(tokens, afterMs);
  const items = response.items || [];

  if (options.verbose) {
    console.log(`[spotify] API returned ${items.length} play(s)`);
  }

  if (options.dryRun) {
    return { imported: 0, skipped: items.length, apiRecords: items.length };
  }

  const importBatch = `spotify-api-${accountName}-${Date.now()}`;

  // Load resource cache for playlist name lookups
  const resourceCache = getAllSpotifyResources(appDb);
  const missingPlaylistCache = loadMissingPlaylistCache(appDb);
  if (options.verbose && resourceCache.size > 0) {
    console.log(`[spotify] Loaded ${resourceCache.size} cached resource(s)`);
  }

  // Resolve unknown playlist URIs before insert
  if (!options.dryRun) {
    const unknownUris = collectUnknownPlaylistUris(items, resourceCache, {
      missingCache: missingPlaylistCache,
    });
    if (unknownUris.length > 0) {
      if (options.verbose) {
        console.log(`[spotify] Found ${unknownUris.length} unknown playlist URI(s)`);
      }
      const { resolved, missingUpdated } = await resolvePlaylistNames(
        tokens,
        unknownUris,
        appDb,
        resourceCache,
        missingPlaylistCache,
        options
      );
      if (missingUpdated) {
        saveMissingPlaylistCache(appDb, missingPlaylistCache);
      }
      if (options.verbose && resolved > 0) {
        console.log(`[spotify] Resolved ${resolved} playlist name(s)`);
      }
    }
  }

  const people = JSON.stringify(["spotify:" + accountName]);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, duration_ms,
      title, content, tags, raw_data, import_batch, people
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;
  let latestPlayedAtMs: number | undefined;

  const insertMany = db.transaction((plays: SpotifyPlayHistoryItem[]) => {
    for (const item of plays) {
      const playedAt = item.played_at;
      const playedAtMs = Date.parse(playedAt);
      if (!Number.isFinite(playedAtMs)) {
        totalSkipped++;
        continue;
      }

      if (!item.track || !item.track.uri) {
        totalSkipped++;
        continue;
      }

      const title = item.track.name || null;
      const content = buildContent(item.track);
      const sourceId = `${item.track.uri}@${playedAt}`;
      const tags = buildTags(item.track, item.context, resourceCache);

      const result = insert.run(
        "spotify",
        sourceId,
        accountName,
        "listen:track",
        playedAt,
        null,
        title,
        content,
        JSON.stringify(tags),
        JSON.stringify(item),
        importBatch,
        people
      );

      if (result.changes > 0) {
        totalImported++;
      } else {
        totalSkipped++;
      }

      if (!latestPlayedAtMs || playedAtMs > latestPlayedAtMs) {
        latestPlayedAtMs = playedAtMs;
      }
    }
  });

  insertMany(items);

  // Cache track URI → album art URL for image lookups
  // Resolution preference: 300px → 64px → first (keep in sync with web/src/lib/spotify-art.ts)
  for (const item of items) {
    if (!item.track?.uri) continue;
    const images = item.track.album?.images;
    const imageUrl = images?.find(img => img.height === 300)?.url
      ?? images?.find(img => img.height === 64)?.url
      ?? images?.[0]?.url;
    if (imageUrl) {
      setSpotifyResource(appDb, item.track.uri, "track", item.track.name, imageUrl);
    }
  }

  if (latestPlayedAtMs) {
    const nextState: SpotifySyncState = {
      lastPlayedAtMs: latestPlayedAtMs,
      lastPlayedAt: new Date(latestPlayedAtMs).toISOString(),
    };
    setSyncState(appDb, SYNC_STATE_KEY, nextState);
  }

  return {
    imported: totalImported,
    skipped: totalSkipped,
    apiRecords: items.length,
  };
}

export async function syncSpotify(
  sourceAccount?: string,
  options: { verbose?: boolean; headless?: boolean; dryRun?: boolean } = {}
): Promise<SpotifySyncStats> {
  const db = getDb();
  initDb(db);
  try {
    return await syncSpotifyWithDb(db, sourceAccount, options);
  } finally {
    db.close();
  }
}

/** Get stored account name from tokens (if authenticated) */
export function getStoredAccountName(): string | undefined {
  const tokens = tokenManager.load();
  return tokens?.account_name;
}

/**
 * Get a valid (auto-refreshed) Spotify access token, for callers that need to
 * make their own API requests. In headless mode it refreshes silently and
 * throws if re-authorization would be required (no interactive prompt).
 */
export async function getValidSpotifyTokens(
  options: { headless?: boolean } = {},
): Promise<SpotifyTokens> {
  const config = requireSpotifyConfig();
  const oauthClient = createSpotifyOAuthClient(config);
  return oauthClient.ensureValidToken({ headless: options.headless });
}

export async function ensureAuthenticated(): Promise<void> {
  await getValidSpotifyTokens();
}

function showStatus(): void {
  const config = loadSpotifyConfig();
  const tokens = tokenManager.load();

  console.log("Spotify API Status");
  console.log("=".repeat(40));

  if (!config) {
    console.log("Config: missing");
    console.log(`  Create ${SPOTIFY_CONFIG_PATH} with client_id (and optional client_secret)`);
    return;
  }

  console.log(`Client ID: ${config.client_id.substring(0, 8)}...`);

  if (tokens) {
    const expiresIn = tokens.expires_at - Date.now();
    const expiresInMins = Math.round(expiresIn / 60000);

    if (expiresIn > 0) {
      console.log(`Token: valid (expires in ${expiresInMins}m)`);
    } else {
      console.log(`Token: expired (${Math.abs(expiresInMins)}m ago)`);
      console.log("  Will auto-refresh on next sync");
    }
    console.log(`Refresh token: ${tokens.refresh_token ? "present" : "missing"}`);
    if (tokens.account_name) {
      console.log(`Account: ${tokens.account_name}`);
    }
  } else {
    console.log("Token: not authenticated");
    console.log("  Run: bun run src/parsers/spotify-api.ts auth");
  }
}

// CLI
if (import.meta.main) {
  const command = process.argv[2];

  if (command === "auth") {
    const config = requireSpotifyConfig();
    const oauthClient = createSpotifyOAuthClient(config);
    await oauthClient.authorize();
  } else if (command === "status") {
    showStatus();
  } else if (command === "reset") {
    const appDb = getAppStateDb();
    deleteSyncState(appDb, "spotify");
    deleteSyncState(appDb, SYNC_STATE_KEY);
    console.log("Spotify tokens cleared from database.");
  } else if (command === "help" || command === "-h" || command === "--help") {
    console.log(`Spotify API Parser

Usage:
  bun run src/parsers/spotify-api.ts              # Sync recently played tracks
  bun run src/parsers/spotify-api.ts auth         # Authenticate via OAuth
  bun run src/parsers/spotify-api.ts status       # Check auth status
  bun run src/parsers/spotify-api.ts reset        # Clear stored tokens

First run 'auth' to authorize, then run without arguments to sync.
Account name is auto-detected from your Spotify profile.
`);
  } else {
    await syncSpotify(undefined, { verbose: true });
  }
}
