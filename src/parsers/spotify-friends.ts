#!/usr/bin/env bun
/**
 * Spotify Friends Activity Parser
 *
 * Syncs friends' listening activity via Spotify's unofficial buddylist API.
 * Uses the same internal endpoint as the Spotify desktop client's "Friend Activity" sidebar.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";
import { deleteSyncState, getAppStateDb, getSyncState, setSyncState, setSpotifyResource } from "../db/app-state";
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
  name: string;
  index: number;
}

interface FriendTrack {
  uri: string;
  name: string;
  imageUrl: string;
  album: FriendTrackAlbum;
  artist: FriendTrackArtist;
  context?: FriendTrackContext;
}

interface FriendActivity {
  timestamp: number;
  user: FriendUser;
  track: FriendTrack;
}

interface BuddylistResponse {
  friends: FriendActivity[];
}

interface AccessTokenResponse {
  accessToken: string;
  accessTokenExpirationTimestampMs: number;
  isAnonymous: boolean;
}

interface SpotifyFriendsSyncState {
  lastSyncedTimestamps?: Record<string, number>; // friend_uri -> last seen timestamp
}

export interface SpotifyFriendsSyncStats {
  imported: number;
  skipped: number;
  friendsCount: number;
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

/**
 * Fetch friend activity from the buddylist endpoint.
 */
async function fetchFriendActivity(accessToken: string): Promise<FriendActivity[]> {
  const response = await fetch(
    "https://guc-spclient.spotify.com/presence-view/v1/buddylist",
    {
      headers: {
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Access token rejected. The sp_dc cookie may be invalid or expired.");
    }
    throw new Error(`Buddylist API error: ${response.status} ${response.statusText}`);
  }

  const data: BuddylistResponse = await response.json();
  return data.friends || [];
}

// ============================================================================
// User Profile (for avatars)
// ============================================================================

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyUserProfile {
  id: string;
  display_name: string | null;
  images: SpotifyImage[];
}

/**
 * Fetch a user's public profile to get their avatar.
 * Returns the largest image URL, or null if unavailable.
 */
async function fetchUserProfileImage(accessToken: string, userId: string): Promise<string | null> {
  const response = await fetch(`https://api.spotify.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) return null;

  const profile: SpotifyUserProfile = await response.json();
  if (!profile.images || profile.images.length === 0) return null;

  // Pick the largest image (last in array is typically largest, but sort to be safe)
  const sorted = [...profile.images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0].url;
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

function normalizeTimestampMs(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value < 1e12) return value * 1000; // seconds -> ms
  if (value > 1e15) return Math.floor(value / 1000); // microseconds -> ms
  return value;
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
    console.log("[spotify-friends] Fetching friend activity...");
  }

  const friends = await fetchFriendActivity(accessToken);

  if (options.verbose) {
    console.log(`[spotify-friends] Found ${friends.length} friend(s) with activity`);
  }

  const importBatch = `spotify-friends-${Date.now()}`;

  if (options.dryRun) {
    for (const friend of friends) {
      console.log(`  ${friend.user.name}: ${friend.track.name} by ${friend.track.artist.name}`);
    }
    return { imported: 0, skipped: friends.length, friendsCount: friends.length };
  }

  const appDb = getAppStateDb();
  const syncState = getSyncState<SpotifyFriendsSyncState>(appDb, SYNC_STATE_KEY);
  const seenTimestamps = syncState?.lastSyncedTimestamps || {};

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;
  const newSeenTimestamps: Record<string, number> = { ...seenTimestamps };

  const insertMany = db.transaction((activities: FriendActivity[]) => {
    for (const activity of activities) {
      const { user, track, timestamp } = activity;
      const timestampMs = normalizeTimestampMs(timestamp);

      // Skip if we've already seen this exact activity (same friend, same timestamp)
      const lastSeenTs = seenTimestamps[user.uri];
      if (lastSeenTs && timestampMs <= lastSeenTs) {
        totalSkipped++;
        continue;
      }

      const timestampIso = new Date(timestampMs).toISOString();
      const sourceId = `spotify:friend:${user.uri}:${track.uri}@${timestampMs}`;
      const title = track.name;
      const content = buildContent(track);
      // Extract username from URI (spotify:user:USERNAME -> USERNAME)
      const friendAccount = user.uri.replace("spotify:user:", "");
      const people = [`spotify:${friendAccount}`];
      const tags = buildTags(track);

      const result = insert.run(
        "spotify-friends",
        sourceId,
        friendAccount,
        "listen:track:friend",
        timestampIso,
        title,
        content,
        JSON.stringify(people),
        JSON.stringify(tags),
        JSON.stringify(activity),
        importBatch
      );

      if (result.changes > 0) {
        totalImported++;
        if (options.verbose) {
          console.log(`  + ${user.name}: ${track.name}`);
        }
      } else {
        totalSkipped++;
      }

      // Track the latest timestamp we've seen for each friend
      if (!newSeenTimestamps[user.uri] || timestampMs > newSeenTimestamps[user.uri]) {
        newSeenTimestamps[user.uri] = timestampMs;
      }
    }
  });

  insertMany(friends);

  // Cache URI → name mappings for future lookups (e.g., spotify-api playlist resolution)
  // Also cache track URI → album art URL for image lookups
  for (const activity of friends) {
    const { track } = activity;
    if (track.artist?.uri && track.artist?.name) {
      setSpotifyResource(appDb, track.artist.uri, "artist", track.artist.name);
    }
    if (track.album?.uri && track.album?.name) {
      setSpotifyResource(appDb, track.album.uri, "album", track.album.name);
    }
    if (track.uri && track.name && track.imageUrl) {
      setSpotifyResource(appDb, track.uri, "track", track.name, track.imageUrl);
    }
    if (track.context?.uri && track.context?.name) {
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

  // Upsert identities and fetch avatars for friends
  // Deduplicate friends by URI (buddylist can list same friend multiple times)
  const uniqueFriends = new Map<string, FriendActivity>();
  for (const activity of friends) {
    uniqueFriends.set(activity.user.uri, activity);
  }

  // Check which friends already have avatars (skip re-fetching)
  const existingAvatars = new Set<string>();
  const checkAvatarStmt = db.prepare(
    `SELECT avatar_url FROM identities WHERE platform = 'spotify' AND platform_id = ?`
  );
  for (const [, activity] of uniqueFriends) {
    const username = activity.user.uri.replace("spotify:user:", "");
    const row = checkAvatarStmt.get(username) as { avatar_url: string | null } | null;
    if (row?.avatar_url) {
      existingAvatars.add(username);
    }
  }

  for (const [, activity] of uniqueFriends) {
    const username = activity.user.uri.replace("spotify:user:", "");
    let avatarUrl: string | null = null;

    // Only fetch profile if we don't already have an avatar
    if (!existingAvatars.has(username)) {
      try {
        avatarUrl = await fetchUserProfileImage(accessToken, username);
        if (options.verbose && avatarUrl) {
          console.log(`  [avatar] ${activity.user.name}: ${avatarUrl}`);
        }
      } catch {
        // Avatar fetch failed — not critical, continue
      }
    }

    upsertIdentity(db, {
      platform: "spotify",
      platformId: username,
      displayName: activity.user.name,
      ...(avatarUrl ? { avatarUrl } : {}),
    });
  }

  // Update sync state with new timestamps
  setSyncState(appDb, SYNC_STATE_KEY, { lastSyncedTimestamps: newSeenTimestamps });

  return {
    imported: totalImported,
    skipped: totalSkipped,
    friendsCount: friends.length,
  };
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

  console.log(`Config: present (sp_dc: ${config.sp_dc.substring(0, 10)}...)`);

  // Test the cookie
  try {
    console.log("Testing cookie...");
    const accessToken = await getWebAccessToken(config);
    console.log(`Access token: valid (${accessToken.substring(0, 20)}...)`);

    // Try fetching friend activity
    const friends = await fetchFriendActivity(accessToken);
    console.log(`Friends online: ${friends.length}`);

    if (friends.length > 0) {
      console.log("\nCurrently listening:");
      for (const friend of friends.slice(0, 5)) {
        const ago = Math.round((Date.now() - normalizeTimestampMs(friend.timestamp)) / 60000);
        console.log(`  ${friend.user.name}: ${friend.track.name} (${ago}m ago)`);
      }
      if (friends.length > 5) {
        console.log(`  ... and ${friends.length - 5} more`);
      }
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
  bun run src/parsers/spotify-friends.ts status       # Check cookie and show friends
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
