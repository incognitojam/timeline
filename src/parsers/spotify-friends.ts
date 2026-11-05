#!/usr/bin/env bun
/**
 * Spotify Friends Activity Parser
 *
 * Syncs friends' listening activity via Spotify's unofficial listening-activity
 * feed, the route the current web player uses for its "Listening activity" panel.
 * The feed carries URIs only, so names and artwork are looked up separately.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getDb, initDb } from "../db/schema";
import {
  deleteSyncState,
  getAppStateDb,
  getSpotifyResource,
  getSyncState,
  setSyncState,
  setSpotifyResource,
} from "../db/app-state";
import { upsertIdentity } from "../db/identities";

// ============================================================================
// Types
// ============================================================================

export interface SpotifyFriendsConfig {
  sp_dc: string;
  totp_secret: string;
  totp_version: number;
}

interface FriendUser {
  uri: string;
  name: string;
}

interface FriendTrackArtist {
  uri: string;
  name: string;
}

interface FriendTrackAlbum {
  uri: string;
  name: string;
}

interface FriendTrackContext {
  uri: string;
  /** Absent when Spotify won't say, e.g. a playlist this account can't read. */
  name?: string;
}

interface FriendTrack {
  uri: string;
  name: string;
  imageUrl?: string;
  durationMs: number;
  album: FriendTrackAlbum;
  artist: FriendTrackArtist;
  context?: FriendTrackContext;
}

/** One listen as stored in raw_data: the feed entity plus what was looked up for it. */
interface FriendActivity {
  timestamp: number;
  user: FriendUser;
  track: FriendTrack;
  listeningActivity: ListeningActivityEntity;
}

interface AccessTokenResponse {
  accessToken: string;
  accessTokenExpirationTimestampMs: number;
  isAnonymous: boolean;
}

interface SpotifyFriendsSyncState {
  lastSyncedTimestamps?: Record<string, number>; // friend_uri -> last seen timestamp
  lastPlaying?: Record<string, boolean>; // friend_uri -> isPlaying at the last sync
}

export interface SpotifyFriendsSyncStats {
  imported: number;
  skipped: number;
  friendsCount: number;
  /** First lookup failure. Listens it affected are retried on the next sync. */
  error?: string;
}

// ============================================================================
// Config
// ============================================================================

const CONFIG_DIR = join(homedir(), ".config", "timeline");
export const SPOTIFY_FRIENDS_CONFIG_PATH = join(CONFIG_DIR, "spotify-friends.json");
const SYNC_STATE_KEY = "spotify-friends-sync";

export function loadSpotifyFriendsConfig(): SpotifyFriendsConfig | null {
  if (!existsSync(SPOTIFY_FRIENDS_CONFIG_PATH)) {
    return null;
  }

  try {
    const saved: unknown = JSON.parse(readFileSync(SPOTIFY_FRIENDS_CONFIG_PATH, "utf-8"));
    if (
      typeof saved === "object" &&
      saved !== null &&
      "sp_dc" in saved &&
      typeof saved.sp_dc === "string" &&
      saved.sp_dc.length > 0 &&
      "totp_secret" in saved &&
      typeof saved.totp_secret === "string" &&
      saved.totp_secret.length > 0 &&
      "totp_version" in saved &&
      typeof saved.totp_version === "number" &&
      Number.isInteger(saved.totp_version) &&
      saved.totp_version > 0
    ) {
      return {
        sp_dc: saved.sp_dc,
        totp_secret: saved.totp_secret,
        totp_version: saved.totp_version,
      };
    }
  } catch {
    // Config malformed
  }

  return null;
}

function requireSpotifyFriendsConfig(): SpotifyFriendsConfig {
  const config = loadSpotifyFriendsConfig();
  if (!config) {
    throw new Error(
      `Spotify Friends not configured. Create ${SPOTIFY_FRIENDS_CONFIG_PATH} with:\n` +
        '{"sp_dc": "YOUR_SP_DC_COOKIE", "totp_secret": "YOUR_CURRENT_TOTP_SECRET", "totp_version": 1}\n\n' +
        "To get the cookie:\n" +
        "1. Log into open.spotify.com\n" +
        "2. Open DevTools > Application > Cookies > open.spotify.com\n" +
        "3. Copy the value of sp_dc"
    );
  }
  return config;
}

// ============================================================================
// TOTP Generation (for Spotify's anti-bot protection)
// ============================================================================

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const XOR_MOD = 33;
const XOR_ADD = 9;

function decodeSecret(secret: string): Uint8Array {
  const processed = secret.split("").map((char, i) => char.charCodeAt(0) ^ ((i % XOR_MOD) + XOR_ADD));
  const processedStr = processed.join("");
  const utf8Bytes = new TextEncoder().encode(processedStr);
  let hexStr = Array.from(utf8Bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  hexStr = hexStr.replace(/[^0-9a-fA-F]/g, "");
  if (hexStr.length % 2 !== 0) hexStr = hexStr.slice(0, -1);
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  // Create copies to ensure ArrayBuffer backing (not SharedArrayBuffer)
  const keyBuffer = new Uint8Array(key);
  const messageBuffer = new Uint8Array(message);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, messageBuffer);
  return new Uint8Array(signature);
}

async function generateTOTP(timestampMs: number, secret: Uint8Array): Promise<string> {
  // TOTP with 30-second time step
  const counter = Math.floor(timestampMs / 1000 / 30);
  const counterBuffer = new ArrayBuffer(8);
  const counterView = new DataView(counterBuffer);
  counterView.setBigUint64(0, BigInt(counter), false);

  const hmac = await hmacSha1(secret, new Uint8Array(counterBuffer));
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1000000).padStart(6, "0");
}

async function getServerTime(): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch("https://open.spotify.com/api/server-time", {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (response.ok) {
      const data = (await response.json()) as { serverTime: number };
      if (data.serverTime && !Number.isNaN(data.serverTime)) {
        return data.serverTime;
      }
    }
  } catch {
    // Server time endpoint blocked, fall through
  } finally {
    clearTimeout(timeout);
  }

  return null;
}

// ============================================================================
// API Helpers
// ============================================================================

/**
 * Exchange sp_dc cookie for an access token.
 * Mirrors the Spotify web player's /api/token flow (TOTP protected).
 */
async function getWebAccessToken(config: SpotifyFriendsConfig): Promise<string> {
  const serverTime = await getServerTime();
  const secret = decodeSecret(config.totp_secret);
  const totp = await generateTOTP(Date.now(), secret);
  const totpServer =
    serverTime && !Number.isNaN(serverTime)
      ? await generateTOTP(serverTime * 1000, secret)
      : "unavailable";

  const params = new URLSearchParams({
    reason: "init",
    productType: "web-player",
    totp,
    totpVer: String(config.totp_version),
    totpServer,
  });

  const response = await fetch(`https://open.spotify.com/api/token?${params}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: `sp_dc=${config.sp_dc}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "sp_dc cookie is invalid or expired. Please extract a fresh cookie from open.spotify.com"
      );
    }
    const text = await response.text();
    throw new Error(`Failed to get access token: ${response.status} ${text.slice(0, 200)}`);
  }

  const data: AccessTokenResponse = await response.json();

  if (data.isAnonymous) {
    throw new Error(
      "sp_dc cookie returned anonymous token. Please extract a fresh cookie from open.spotify.com"
    );
  }

  return data.accessToken;
}

const SPCLIENT_BASE = "https://spclient.wg.spotify.com";
const REQUEST_TIMEOUT_MS = 20_000;

/** Carries only a route label and status, so messages are safe to log. */
class SpotifyRequestError extends Error {
  constructor(
    readonly label: string,
    readonly status: number,
  ) {
    super(`${label} request failed: ${status}`);
    this.name = "SpotifyRequestError";
  }
}

async function spclientRequest(
  accessToken: string,
  label: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${SPCLIENT_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 401) {
    throw new Error(`${label}: access token rejected. The sp_dc cookie may be invalid or expired.`);
  }
  if (!response.ok) {
    throw new SpotifyRequestError(label, response.status);
  }
  return response.json();
}

function parseResponse<T>(schema: z.ZodType<T>, label: string, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // Paths only: issue messages could quote values from private responses.
    const paths = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`${label} response has an unexpected shape at: ${paths}`);
  }
  return parsed.data;
}

// ============================================================================
// Listening Activity Feed
// ============================================================================

const listeningActivityEntitySchema = z.looseObject({
  uri: z.string(),
  activity: z
    .looseObject({
      entityUri: z.string(),
      contextUri: z.string().optional(),
      isPlaying: z.boolean().optional(),
      timestamp: z.string(),
    })
    .optional(),
});

const listeningActivityFeedSchema = z.looseObject({
  entities: z.array(
    z.looseObject({
      userEntity: listeningActivityEntitySchema.optional(),
      followEntity: listeningActivityEntitySchema.optional(),
    }),
  ),
});

type RawListeningActivityEntity = z.infer<typeof listeningActivityEntitySchema>;
type ListeningActivityEntity = RawListeningActivityEntity & {
  activity: NonNullable<RawListeningActivityEntity["activity"]>;
};

interface FeedEntry {
  entity: ListeningActivityEntity;
  timestampMs: number;
}

/**
 * Fetch friends' latest listens, oldest first. `ignored` counts entities that
 * aren't a friend's track, such as a podcast episode.
 */
async function fetchListeningActivity(
  accessToken: string,
): Promise<{ entries: FeedEntry[]; ignored: number }> {
  const payload = await spclientRequest(accessToken, "Listening activity", "/listening-activity/v1/feed", {
    unused: true,
    resultLimit: 100,
  });
  const feed = parseResponse(listeningActivityFeedSchema, "Listening activity", payload);

  const entries: FeedEntry[] = [];
  let ignored = 0;
  for (const item of feed.entities) {
    const entity = item.userEntity ?? item.followEntity;
    if (!entity?.uri.startsWith("spotify:user:") || !entity.activity?.entityUri.startsWith("spotify:track:")) {
      ignored++;
      continue;
    }
    const timestampMs = Date.parse(entity.activity.timestamp);
    if (Number.isNaN(timestampMs)) {
      throw new Error("Listening activity response has an unparseable timestamp");
    }
    entries.push({ entity: { ...entity, activity: entity.activity }, timestampMs });
  }

  entries.sort((a, b) => a.timestampMs - b.timestampMs);
  return { entries, ignored };
}

// ============================================================================
// Name and Artwork Lookups
// ============================================================================

const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Spotify's metadata routes address items by a 32-digit hex gid rather than the base62 id in a URI. */
function base62ToGid(id: string): string {
  let value = 0n;
  for (const char of id) {
    const digit = BASE62.indexOf(char);
    if (digit === -1) throw new Error("Spotify id is not base62");
    value = value * 62n + BigInt(digit);
  }
  return value.toString(16).padStart(32, "0");
}

function gidToBase62(gid: string): string {
  let value = BigInt(`0x${gid}`);
  let id = "";
  while (value > 0n) {
    id = BASE62[Number(value % 62n)] + id;
    value /= 62n;
  }
  return id.padStart(22, "0");
}

const trackMetadataSchema = z.looseObject({
  name: z.string(),
  duration: z.number(),
  album: z.looseObject({
    gid: z.string(),
    name: z.string(),
    cover_group: z
      .looseObject({
        image: z.array(z.looseObject({ file_id: z.string(), size: z.string().optional() })),
      })
      .optional(),
  }),
  artist: z
    .array(z.looseObject({ gid: z.string(), name: z.string() }))
    .min(1),
});

type TrackDetails = Omit<FriendTrack, "context">;

async function fetchTrackDetails(accessToken: string, trackUri: string): Promise<TrackDetails> {
  const id = trackUri.slice("spotify:track:".length);
  const payload = await spclientRequest(accessToken, "Track metadata", `/metadata/4/track/${base62ToGid(id)}`);
  const metadata = parseResponse(trackMetadataSchema, "Track metadata", payload);

  const images = metadata.album.cover_group?.image ?? [];
  // LARGE is the variant the old feed returned, so old and new events show the same art.
  const cover = images.find((image) => image.size === "LARGE") ?? images[0];
  const artist = metadata.artist[0];

  return {
    uri: trackUri,
    name: metadata.name,
    ...(cover ? { imageUrl: `https://i.scdn.co/image/${cover.file_id}` } : {}),
    durationMs: metadata.duration,
    album: { uri: `spotify:album:${gidToBase62(metadata.album.gid)}`, name: metadata.album.name },
    artist: { uri: `spotify:artist:${gidToBase62(artist.gid)}`, name: artist.name },
  };
}

const userProfileSchema = z.looseObject({
  name: z.string().optional(),
  image_url: z.string().optional(),
});

async function fetchUserProfile(
  accessToken: string,
  username: string,
): Promise<{ name?: string; avatarUrl?: string }> {
  const params = new URLSearchParams({
    playlist_limit: "0",
    artist_limit: "0",
    episode_limit: "0",
    market: "from_token",
  });
  const payload = await spclientRequest(
    accessToken,
    "User profile",
    `/user-profile-view/v3/profile/${encodeURIComponent(username)}?${params}`,
  );
  const profile = parseResponse(userProfileSchema, "User profile", payload);
  return {
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.image_url ? { avatarUrl: profile.image_url } : {}),
  };
}

const playlistMetadataSchema = z.looseObject({
  attributes: z.looseObject({ name: z.string() }),
});

/** Returns null for a playlist this account can't read; other failures throw. */
async function fetchPlaylistName(accessToken: string, playlistUri: string): Promise<string | null> {
  const id = playlistUri.slice("spotify:playlist:".length);
  try {
    const payload = await spclientRequest(accessToken, "Playlist metadata", `/playlist/v2/playlist/${id}/metadata`);
    return parseResponse(playlistMetadataSchema, "Playlist metadata", payload).attributes.name;
  } catch (error) {
    if (error instanceof SpotifyRequestError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

// ============================================================================
// Sync Logic
// ============================================================================

function buildContent(track: FriendTrack): string {
  return [
    track.name,
    track.artist?.name && `by ${track.artist.name}`,
    track.album?.name && `from ${track.album.name}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildTags(track: FriendTrack): string[] {
  const tags = new Set<string>();

  if (track.album?.name) {
    tags.add(`album:${track.album.name}`);
  }
  if (track.artist?.name) {
    tags.add(`artist:${track.artist.name}`);
  }

  if (track.context?.name) {
    const contextUri = track.context.uri ?? "";
    if (contextUri.startsWith("spotify:playlist:")) {
      tags.add(`playlist:${track.context.name}`);
    } else if (contextUri.startsWith("spotify:album:")) {
      tags.add(`album:${track.context.name}`);
    } else if (contextUri.startsWith("spotify:artist:")) {
      tags.add(`artist:${track.context.name}`);
    } else {
      tags.add(`context:${track.context.name}`);
    }
  }

  return Array.from(tags);
}

/** A same-track timestamp this close to a full track length later still counts as a repeat. */
const REPEAT_TOLERANCE_MS = 5_000;

interface StoredListen {
  trackUri: string | null;
  timestampMs: number;
  durationMs: number | null;
}

function getLastStoredListen(db: Database, friendAccount: string): StoredListen | null {
  const row = db
    .prepare(`
      SELECT
        timestamp,
        json_extract(raw_data, '$.track.uri') AS trackUri,
        json_extract(raw_data, '$.track.durationMs') AS durationMs
      FROM events
      WHERE source = 'spotify-friends' AND source_account = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `)
    .get(friendAccount) as { timestamp: string; trackUri: string | null; durationMs: number | null } | null;
  if (!row) return null;
  return { trackUri: row.trackUri, timestampMs: Date.parse(row.timestamp), durationMs: row.durationMs };
}

/** Lookups for one sync. Friends can be playing the same track, so tracks are memoised per run. */
class FeedHydrator {
  private readonly tracks = new Map<string, Promise<TrackDetails>>();

  constructor(
    private readonly db: Database,
    private readonly appDb: Database,
    private readonly accessToken: string,
  ) {}

  track(trackUri: string): Promise<TrackDetails> {
    let details = this.tracks.get(trackUri);
    if (!details) {
      details = fetchTrackDetails(this.accessToken, trackUri);
      this.tracks.set(trackUri, details);
    }
    return details;
  }

  async context(contextUri: string | undefined, track: TrackDetails): Promise<FriendTrackContext | undefined> {
    if (!contextUri) return undefined;
    if (contextUri === track.album.uri) return { uri: contextUri, name: track.album.name };
    if (contextUri === track.artist.uri) return { uri: contextUri, name: track.artist.name };

    const cached = getSpotifyResource(this.appDb, contextUri);
    if (cached) return { uri: contextUri, name: cached.name };

    if (contextUri.startsWith("spotify:playlist:")) {
      const name = await fetchPlaylistName(this.accessToken, contextUri);
      if (name) return { uri: contextUri, name };
    }
    return { uri: contextUri };
  }

  /**
   * The friend's current name and avatar. A friend already known keeps their
   * stored name if the profile can't be fetched, so a profile outage doesn't
   * hold back listens.
   */
  async friend(friendAccount: string): Promise<{ name: string; avatarUrl?: string }> {
    const known = this.db
      .prepare(`SELECT display_name FROM identities WHERE platform = 'spotify' AND platform_id = ?`)
      .get(friendAccount) as { display_name: string | null } | null;

    try {
      const profile = await fetchUserProfile(this.accessToken, friendAccount);
      return { ...profile, name: profile.name ?? known?.display_name ?? friendAccount };
    } catch (error) {
      if (known?.display_name) return { name: known.display_name };
      throw error;
    }
  }
}

async function syncFriendsWithDb(
  db: Database,
  options: { verbose?: boolean; dryRun?: boolean } = {}
): Promise<SpotifyFriendsSyncStats> {
  const config = requireSpotifyFriendsConfig();

  if (options.verbose) {
    console.log("[spotify-friends] Getting access token...");
  }

  const accessToken = await getWebAccessToken(config);

  if (options.verbose) {
    console.log("[spotify-friends] Fetching listening activity...");
  }

  const { entries, ignored } = await fetchListeningActivity(accessToken);
  const friendsCount = new Set(entries.map((entry) => entry.entity.uri)).size;

  if (options.verbose) {
    console.log(`[spotify-friends] Found ${friendsCount} friend(s) with activity`);
  }

  if (options.dryRun) {
    return { imported: 0, skipped: entries.length + ignored, friendsCount };
  }

  const importBatch = `spotify-friends-${Date.now()}`;
  const appDb = getAppStateDb();
  const syncState = getSyncState<SpotifyFriendsSyncState>(appDb, SYNC_STATE_KEY);
  const seenTimestamps = { ...syncState?.lastSyncedTimestamps };
  const lastPlaying = { ...syncState?.lastPlaying };
  const hydrator = new FeedHydrator(db, appDb, accessToken);

  let imported = 0;
  let skipped = ignored;
  let error: string | undefined;

  for (const entry of entries) {
    const userUri = entry.entity.uri;
    const lastSeenTs = seenTimestamps[userUri];
    if (lastSeenTs && entry.timestampMs <= lastSeenTs) {
      skipped++;
      continue;
    }

    try {
      if (await importEntry(db, appDb, hydrator, entry, lastPlaying[userUri] === true, importBatch)) {
        imported++;
      } else {
        skipped++;
      }
      seenTimestamps[userUri] = entry.timestampMs;
    } catch (caught) {
      // The watermark stays put, so the next sync retries this listen.
      error ??= caught instanceof Error ? caught.message : String(caught);
      if (caught instanceof SpotifyRequestError && caught.status === 429) break;
    }
  }

  for (const { entity } of entries) {
    lastPlaying[entity.uri] = entity.activity.isPlaying === true;
  }

  setSyncState(appDb, SYNC_STATE_KEY, { lastSyncedTimestamps: seenTimestamps, lastPlaying });

  return { imported, skipped, friendsCount, ...(error ? { error } : {}) };
}

/** Stores a feed entry unless it's a play already recorded. Returns whether it added an event. */
async function importEntry(
  db: Database,
  appDb: Database,
  hydrator: FeedHydrator,
  { entity, timestampMs }: FeedEntry,
  wasPlaying: boolean,
  importBatch: string,
): Promise<boolean> {
  const userUri = entity.uri;
  const trackUri = entity.activity.entityUri;
  // Extract username from URI (spotify:user:USERNAME -> USERNAME)
  const friendAccount = userUri.replace("spotify:user:", "");

  const last = getLastStoredListen(db, friendAccount);
  const playedThrough = wasPlaying && entity.activity.isPlaying === true;
  if (last && (await isSameListen(hydrator, last, trackUri, timestampMs, playedThrough))) return false;

  const details = await hydrator.track(trackUri);
  const context = await hydrator.context(entity.activity.contextUri, details);
  const friend = await hydrator.friend(friendAccount);
  const track: FriendTrack = { ...details, ...(context ? { context } : {}) };
  const activity: FriendActivity = {
    timestamp: timestampMs,
    user: { uri: userUri, name: friend.name },
    track,
    listeningActivity: entity,
  };

  const result = db
    .prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, people, tags, raw_data, import_batch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "spotify-friends",
      `spotify:friend:${userUri}:${trackUri}@${timestampMs}`,
      friendAccount,
      "listen:track:friend",
      new Date(timestampMs).toISOString(),
      track.name,
      buildContent(track),
      JSON.stringify([`spotify:${friendAccount}`]),
      JSON.stringify(buildTags(track)),
      JSON.stringify(activity),
      importBatch,
    );

  cacheResources(appDb, track);
  upsertIdentity(db, {
    platform: "spotify",
    platformId: friendAccount,
    displayName: friend.name,
    ...(friend.avatarUrl ? { avatarUrl: friend.avatarUrl } : {}),
  });

  return result.changes > 0;
}

/**
 * The feed's timestamp also moves on a seek or a resume, so a moved timestamp
 * alone doesn't mean a new listen. It's a repeat only once a full track length
 * has passed and the friend was playing at both this sync and the last, which
 * rules out a long pause.
 */
async function isSameListen(
  hydrator: FeedHydrator,
  last: StoredListen,
  trackUri: string,
  timestampMs: number,
  playedThrough: boolean,
): Promise<boolean> {
  if (timestampMs <= last.timestampMs) return true;
  if (last.trackUri !== trackUri) return false;
  if (!playedThrough) return true;
  const durationMs = last.durationMs ?? (await hydrator.track(trackUri)).durationMs;
  return timestampMs - last.timestampMs < durationMs - REPEAT_TOLERANCE_MS;
}

/** Cache URI -> name mappings for later lookups (e.g., spotify-api playlist resolution). */
function cacheResources(appDb: Database, track: FriendTrack): void {
  setSpotifyResource(appDb, track.artist.uri, "artist", track.artist.name);
  setSpotifyResource(appDb, track.album.uri, "album", track.album.name);
  setSpotifyResource(appDb, track.uri, "track", track.name, track.imageUrl);
  if (track.context?.name) {
    const contextUri = track.context.uri;
    const type = contextUri.startsWith("spotify:playlist:")
      ? "playlist"
      : contextUri.startsWith("spotify:album:")
        ? "album"
        : contextUri.startsWith("spotify:artist:")
          ? "artist"
          : "context";
    setSpotifyResource(appDb, contextUri, type, track.context.name);
  }
}

export async function syncSpotifyFriends(
  options: { verbose?: boolean; dryRun?: boolean } = {}
): Promise<SpotifyFriendsSyncStats> {
  const db = getDb();
  initDb(db);
  try {
    return await syncFriendsWithDb(db, options);
  } finally {
    db.close();
  }
}

// ============================================================================
// CLI
// ============================================================================

async function showStatus(): Promise<void> {
  console.log("Spotify Friends Status");
  console.log("=".repeat(40));

  const config = loadSpotifyFriendsConfig();

  if (!config) {
    console.log("Config: missing");
    console.log(`  Create ${SPOTIFY_FRIENDS_CONFIG_PATH} with:`);
    console.log(
      '  {"sp_dc": "YOUR_SP_DC_COOKIE", "totp_secret": "YOUR_CURRENT_TOTP_SECRET", "totp_version": 1}'
    );
    return;
  }

  console.log("Config: present");

  // Test the cookie
  try {
    console.log("Testing cookie...");
    const accessToken = await getWebAccessToken(config);
    console.log("Access token: valid");

    const { entries } = await fetchListeningActivity(accessToken);
    const friends = new Set(entries.map((entry) => entry.entity.uri));
    const playing = entries.filter((entry) => entry.entity.activity.isPlaying).length;
    console.log(`Friends with activity: ${friends.size} (${playing} playing now)`);

    const newest = entries.at(-1);
    if (newest) {
      console.log(`Freshest listen: ${Math.round((Date.now() - newest.timestampMs) / 60000)}m ago`);
    }
  } catch (error) {
    console.log(`Cookie test: failed`);
    console.log(`  ${error instanceof Error ? error.message : error}`);
  }

  // Show sync state
  const appDb = getAppStateDb();
  const syncState = getSyncState<SpotifyFriendsSyncState>(appDb, SYNC_STATE_KEY);
  if (syncState?.lastSyncedTimestamps) {
    const friendCount = Object.keys(syncState.lastSyncedTimestamps).length;
    console.log(`\nTracking: ${friendCount} friend(s)`);
  }
}

if (import.meta.main) {
  const command = process.argv[2];

  if (command === "status") {
    await showStatus();
  } else if (command === "reset") {
    const appDb = getAppStateDb();
    deleteSyncState(appDb, SYNC_STATE_KEY);
    console.log("Spotify Friends sync state cleared.");
  } else if (command === "help" || command === "-h" || command === "--help") {
    console.log(`Spotify Friends Activity Parser

Usage:
  bun run src/parsers/spotify-friends.ts              # Sync friend activity
  bun run src/parsers/spotify-friends.ts status       # Check cookie and count friends
  bun run src/parsers/spotify-friends.ts reset        # Clear sync state
  bun run src/parsers/spotify-friends.ts --dry-run    # Preview without saving

Setup:
  1. Log into open.spotify.com
  2. Open DevTools > Application > Cookies > open.spotify.com
  3. Copy the value of the sp_dc cookie
  4. Obtain the current web-player TOTP secret and version
  5. Create ~/.config/timeline/spotify-friends.json:
     {"sp_dc": "YOUR_SP_DC_COOKIE", "totp_secret": "YOUR_CURRENT_TOTP_SECRET", "totp_version": 1}

Note: Uses unofficial Spotify API. Cookie valid ~1 year.
`);
  } else {
    const dryRun = process.argv.includes("--dry-run");
    const stats = await syncSpotifyFriends({ verbose: true, dryRun });
    console.log(`\nDone: ${stats.imported} imported, ${stats.skipped} skipped`);
  }
}
