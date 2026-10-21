/**
 * Steam API Sync
 *
 * Syncs gaming activity from the Steam Web API:
 * - Game library with playtime (steam:game:added, steam:session)
 * - Achievement unlock timestamps (steam:achievement)
 *
 * Session reconstruction: Steam only provides cumulative playtime.
 * We reconstruct sessions by polling and tracking deltas between syncs.
 *
 * Setup: bun run src/parsers/steam-api.ts auth
 * Sync:  bun run src/parsers/steam-api.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import { getAppStateDb, getSyncState, setSyncState, initAppStateDb } from "../db/app-state";
import { upsertIdentity } from "../db/identities";

// ============================================================================
// Types
// ============================================================================

interface SteamConfig {
  api_key: string;
  steam_id: string;
}

export interface SteamOwnedGame {
  appid: number;
  name: string;
  playtime_forever: number; // minutes
  playtime_2weeks?: number; // minutes, only present if played recently
  rtime_last_played: number; // unix timestamp
  img_icon_url?: string;
  has_community_visible_stats?: boolean;
}

export interface SteamOwnedGamesResponse {
  response: {
    game_count: number;
    games: SteamOwnedGame[];
  };
}

export interface SteamPlayerSummary {
  steamid: string;
  personaname: string;
  profileurl: string;
  avatar: string;
  avatarmedium: string;
  avatarfull: string;
  communityvisibilitystate?: number; // 1 = private, 3 = public
}

export interface SteamPlayerSummariesResponse {
  response: {
    players: SteamPlayerSummary[];
  };
}

export interface SteamAchievement {
  apiname: string;
  achieved: number; // 0 or 1
  unlocktime: number; // unix timestamp
  name?: string; // display name (from schema)
  description?: string;
}

export interface SteamPlayerAchievementsResponse {
  playerstats: {
    steamID: string;
    gameName: string;
    achievements?: SteamAchievement[];
    success: boolean;
    error?: string;
  };
}

export interface SteamAchievementSchema {
  name: string; // API name
  defaultvalue: number;
  displayName: string;
  hidden: number;
  description?: string;
}

export interface SteamSchemaForGameResponse {
  game: {
    gameName: string;
    availableGameStats?: {
      achievements?: SteamAchievementSchema[];
    };
  };
}

export interface SteamGameState {
  playtime_forever: number; // minutes, from last sync
  rtime_last_played: number; // unix timestamp
  current_session_id?: string; // source_id of in-progress session (for merging)
  session_delta_minutes?: number; // accumulated delta for current session
  session_first_detected?: string; // ISO timestamp of first detection
}

export interface SteamSyncState {
  games: Record<string, SteamGameState>;
  achievements: Record<string, {
    last_checked: number; // unix timestamp of our check
    count: number; // achievement count at last check
  }>;
  backfill_complete: boolean;
}

// ============================================================================
// Config
// ============================================================================

const CONFIG_PATH = join(homedir(), ".config", "timeline", "steam.json");

export function loadSteamConfig(): SteamConfig | null {
  // Try env vars first
  const envKey = process.env.STEAM_API_KEY;
  const envId = process.env.STEAM_ID;
  if (envKey && envId) {
    return { api_key: envKey, steam_id: envId };
  }

  // Try config file
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (!config.api_key || !config.steam_id) return null;
    return config as SteamConfig;
  } catch {
    return null;
  }
}

function saveSteamConfig(config: SteamConfig): void {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

// ============================================================================
// API Client
// ============================================================================

export const STEAM_API_BASE = "https://api.steampowered.com";

export async function steamGet<T>(
  apiKey: string,
  endpoint: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${STEAM_API_BASE}/${endpoint}`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("format", "json");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Steam API ${endpoint}: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchOwnedGames(config: SteamConfig): Promise<SteamOwnedGame[]> {
  const data = await steamGet<SteamOwnedGamesResponse>(
    config.api_key,
    "IPlayerService/GetOwnedGames/v1",
    {
      steamid: config.steam_id,
      include_appinfo: "1",
      include_played_free_games: "1",
    },
  );
  return data.response.games || [];
}

export async function fetchPlayerSummary(config: SteamConfig): Promise<SteamPlayerSummary | null> {
  const data = await steamGet<SteamPlayerSummariesResponse>(
    config.api_key,
    "ISteamUser/GetPlayerSummaries/v2",
    { steamids: config.steam_id },
  );
  return data.response.players[0] || null;
}

async function fetchPlayerAchievements(
  config: SteamConfig,
  appid: number,
): Promise<SteamAchievement[] | null> {
  try {
    const data = await steamGet<SteamPlayerAchievementsResponse>(
      config.api_key,
      "ISteamUserStats/GetPlayerAchievements/v1",
      { steamid: config.steam_id, appid: String(appid) },
    );
    if (!data.playerstats.success) return null;
    return data.playerstats.achievements || [];
  } catch {
    // Many games don't support achievements - this is expected
    return null;
  }
}

async function fetchAchievementSchema(
  config: SteamConfig,
  appid: number,
): Promise<Map<string, SteamAchievementSchema>> {
  try {
    const data = await steamGet<SteamSchemaForGameResponse>(
      config.api_key,
      "ISteamUserStats/GetSchemaForGame/v2",
      { appid: String(appid) },
    );
    const map = new Map<string, SteamAchievementSchema>();
    for (const a of data.game.availableGameStats?.achievements || []) {
      map.set(a.name, a);
    }
    return map;
  } catch {
    return new Map();
  }
}

// ============================================================================
// Sync Logic (extracted for testability)
// ============================================================================

export interface SyncContext {
  db: Database;
  appDb: Database;
  config: SteamConfig;
  personaName: string;
  now: Date;
}

export interface SyncStats {
  gamesAdded: number;
  sessionsCreated: number;
  sessionsUpdated: number;
  achievementsAdded: number;
}

/**
 * Process owned games: detect new games, create/update sessions.
 * Pure logic extracted for testability - takes db + state + games list.
 */
export function processGames(
  ctx: SyncContext,
  state: SteamSyncState,
  games: SteamOwnedGame[],
): SyncStats {
  const stats: SyncStats = {
    gamesAdded: 0,
    sessionsCreated: 0,
    sessionsUpdated: 0,
    achievementsAdded: 0,
  };

  const nowIso = ctx.now.toISOString();
  const steamIdentity = `steam:${ctx.config.steam_id}`;

  const insertStmt = ctx.db.prepare(`
    INSERT INTO events (source, source_id, source_account, type, timestamp, end_timestamp, duration_ms, title, content, people, tags, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id, source_account) DO UPDATE SET
      timestamp = excluded.timestamp,
      end_timestamp = excluded.end_timestamp,
      duration_ms = excluded.duration_ms,
      title = excluded.title,
      content = excluded.content,
      raw_data = excluded.raw_data
  `);

  const sourceAccount = ctx.personaName;

  ctx.db.transaction(() => {
    for (const game of games) {
      const appidStr = String(game.appid);
      const prior = state.games[appidStr];

      if (!prior) {
        // First observation of this game
        state.games[appidStr] = {
          playtime_forever: game.playtime_forever,
          rtime_last_played: game.rtime_last_played,
        };

        // Create game:added event
        insertStmt.run(
          "steam",
          `game-${game.appid}`,
          sourceAccount,
          "steam:game:added",
          nowIso,
          null,
          null,
          game.name,
          `Added ${game.name} to Steam library`,
          JSON.stringify([steamIdentity]),
          JSON.stringify([`appid:${game.appid}`]),
          JSON.stringify({
            appid: game.appid,
            name: game.name,
            playtime_forever_minutes: game.playtime_forever,
            img_icon_url: game.img_icon_url,
          }),
        );
        stats.gamesAdded++;

        // If this is NOT the initial sync (state already had some games)
        // and the game has playtime, also create a session
        const isInitialSync = Object.keys(state.games).length <= games.length &&
          stats.gamesAdded === Object.keys(state.games).length;

        if (!isInitialSync && game.playtime_forever > 0 && game.rtime_last_played > 0) {
          const sessionId = `session-${game.appid}-${nowIso}`;
          const durationMs = game.playtime_forever * 60 * 1000;
          const endTimestamp = new Date(game.rtime_last_played * 1000).toISOString();
          const startTimestamp = new Date(game.rtime_last_played * 1000 - durationMs).toISOString();

          insertStmt.run(
            "steam",
            sessionId,
            sourceAccount,
            "steam:session",
            startTimestamp,
            endTimestamp,
            durationMs,
            game.name,
            `Played ${game.name}`,
            JSON.stringify([steamIdentity]),
            JSON.stringify([`appid:${game.appid}`]),
            JSON.stringify({
              appid: game.appid,
              name: game.name,
              playtime_delta_minutes: game.playtime_forever,
              rtime_last_played: game.rtime_last_played,
            }),
          );
          stats.sessionsCreated++;
          state.games[appidStr].current_session_id = sessionId;
          state.games[appidStr].session_delta_minutes = game.playtime_forever;
          state.games[appidStr].session_first_detected = nowIso;
        }

        continue;
      }

      // Existing game - check for playtime changes
      const playtimeDelta = game.playtime_forever - prior.playtime_forever;

      if (playtimeDelta < 0) {
        // Playtime decreased (refund, Steam bug?) - update baseline, no event
        state.games[appidStr].playtime_forever = game.playtime_forever;
        state.games[appidStr].rtime_last_played = game.rtime_last_played;
        state.games[appidStr].current_session_id = undefined;
        state.games[appidStr].session_delta_minutes = undefined;
        state.games[appidStr].session_first_detected = undefined;
        continue;
      }

      if (playtimeDelta === 0) {
        // No change - session is over (if there was one)
        if (prior.current_session_id) {
          state.games[appidStr].current_session_id = undefined;
          state.games[appidStr].session_delta_minutes = undefined;
          state.games[appidStr].session_first_detected = undefined;
        }
        continue;
      }

      // Playtime increased
      const totalDeltaMinutes = (prior.session_delta_minutes || 0) + playtimeDelta;
      const durationMs = totalDeltaMinutes * 60 * 1000;
      const endTimestamp = new Date(game.rtime_last_played * 1000).toISOString();
      const startTimestamp = new Date(game.rtime_last_played * 1000 - durationMs).toISOString();

      if (prior.current_session_id) {
        // Extend existing session
        insertStmt.run(
          "steam",
          prior.current_session_id,
          sourceAccount,
          "steam:session",
          startTimestamp,
          endTimestamp,
          durationMs,
          game.name,
          `Played ${game.name}`,
          JSON.stringify([steamIdentity]),
          JSON.stringify([`appid:${game.appid}`]),
          JSON.stringify({
            appid: game.appid,
            name: game.name,
            playtime_delta_minutes: totalDeltaMinutes,
            rtime_last_played: game.rtime_last_played,
          }),
        );
        stats.sessionsUpdated++;

        state.games[appidStr].playtime_forever = game.playtime_forever;
        state.games[appidStr].rtime_last_played = game.rtime_last_played;
        state.games[appidStr].session_delta_minutes = totalDeltaMinutes;
      } else {
        // New session
        const sessionId = `session-${game.appid}-${nowIso}`;

        insertStmt.run(
          "steam",
          sessionId,
          sourceAccount,
          "steam:session",
          startTimestamp,
          endTimestamp,
          durationMs,
          game.name,
          `Played ${game.name}`,
          JSON.stringify([steamIdentity]),
          JSON.stringify([`appid:${game.appid}`]),
          JSON.stringify({
            appid: game.appid,
            name: game.name,
            playtime_delta_minutes: playtimeDelta,
            rtime_last_played: game.rtime_last_played,
          }),
        );
        stats.sessionsCreated++;

        state.games[appidStr].playtime_forever = game.playtime_forever;
        state.games[appidStr].rtime_last_played = game.rtime_last_played;
        state.games[appidStr].current_session_id = sessionId;
        state.games[appidStr].session_delta_minutes = playtimeDelta;
        state.games[appidStr].session_first_detected = nowIso;
      }
    }
  })();

  return stats;
}

/**
 * Process achievements for a set of games.
 */
export async function processAchievements(
  ctx: SyncContext,
  state: SteamSyncState,
  games: SteamOwnedGame[],
): Promise<number> {
  const steamIdentity = `steam:${ctx.config.steam_id}`;
  const sourceAccount = ctx.personaName;
  let achievementsAdded = 0;

  // Determine which games to check:
  // 1. Recently played games (priority)
  const recentlyPlayed = games.filter((g) => g.playtime_2weeks && g.playtime_2weeks > 0);

  // 2. If backfill not complete, add unchecked games (up to 50)
  let backfillGames: SteamOwnedGame[] = [];
  if (!state.backfill_complete) {
    const checkedAppids = new Set(Object.keys(state.achievements));
    const unchecked = games.filter(
      (g) => !checkedAppids.has(String(g.appid)) && !recentlyPlayed.some((r) => r.appid === g.appid),
    );
    backfillGames = unchecked.slice(0, 50);
  }

  const gamesToCheck = [...recentlyPlayed, ...backfillGames];

  const insertStmt = ctx.db.prepare(`
    INSERT OR IGNORE INTO events (source, source_id, source_account, type, timestamp, title, content, people, tags, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const game of gamesToCheck) {
    const appidStr = String(game.appid);
    const achievements = await fetchPlayerAchievements(ctx.config, game.appid);

    if (!achievements) {
      // Game doesn't support achievements, mark as checked
      state.achievements[appidStr] = {
        last_checked: Math.floor(ctx.now.getTime() / 1000),
        count: 0,
      };
      continue;
    }

    const unlocked = achievements.filter((a) => a.achieved === 1 && a.unlocktime > 0);
    const priorCount = state.achievements[appidStr]?.count ?? 0;

    if (unlocked.length > priorCount) {
      // Fetch schema for display names
      const schema = await fetchAchievementSchema(ctx.config, game.appid);

      // Find new achievements (ones we haven't seen before)
      const priorLastChecked = state.achievements[appidStr]?.last_checked ?? 0;
      const newAchievements = priorCount === 0
        ? unlocked // First check - all are "new"
        : unlocked.filter((a) => a.unlocktime > priorLastChecked);

      ctx.db.transaction(() => {
        for (const achievement of newAchievements) {
          const schemaEntry = schema.get(achievement.apiname);
          const displayName = schemaEntry?.displayName || achievement.apiname;
          const description = schemaEntry?.description || "";

          insertStmt.run(
            "steam",
            `achievement-${game.appid}-${achievement.apiname}`,
            sourceAccount,
            "steam:achievement",
            new Date(achievement.unlocktime * 1000).toISOString(),
            `${displayName} (${game.name})`,
            description ? `${displayName}: ${description}` : displayName,
            JSON.stringify([steamIdentity]),
            JSON.stringify([`appid:${game.appid}`, `game:${game.name}`]),
            JSON.stringify({
              appid: game.appid,
              game_name: game.name,
              apiname: achievement.apiname,
              display_name: displayName,
              description,
              unlocktime: achievement.unlocktime,
            }),
          );
          achievementsAdded++;
        }
      })();
    }

    state.achievements[appidStr] = {
      last_checked: Math.floor(ctx.now.getTime() / 1000),
      count: unlocked.length,
    };
  }

  // Check if backfill is complete
  if (!state.backfill_complete) {
    const checkedAppids = new Set(Object.keys(state.achievements));
    const allChecked = games.every((g) => checkedAppids.has(String(g.appid)));
    if (allChecked) {
      state.backfill_complete = true;
    }
  }

  return achievementsAdded;
}

// ============================================================================
// Main Sync
// ============================================================================

export interface SyncSteamOptions {
  headless?: boolean;
}

export async function syncSteam(
  options: SyncSteamOptions = {},
): Promise<{ imported: number; updated: number }> {
  const config = loadSteamConfig();
  if (!config) {
    throw new Error(
      "Steam not configured. Run: bun run src/parsers/steam-api.ts auth",
    );
  }

  const db = getDb();
  initDb(db);
  const appDb = getAppStateDb();

  // Fetch player summary for persona name
  const player = await fetchPlayerSummary(config);
  if (!player) {
    throw new Error("Failed to fetch Steam player summary. Check your API key and Steam ID.");
  }

  const personaName = player.personaname;
  if (!options.headless) {
    console.log(`[steam] Syncing as: ${personaName} (${config.steam_id})`);
  }

  // Upsert identity with display name and avatar
  upsertIdentity(db, {
    platform: "steam",
    platformId: config.steam_id,
    displayName: player.personaname,
    avatarUrl: player.avatarfull,
  });

  // Load or initialize sync state
  let state = getSyncState<SteamSyncState>(appDb, "steam") || {
    games: {},
    achievements: {},
    backfill_complete: false,
  };

  const now = new Date();
  const ctx: SyncContext = { db, appDb, config, personaName, now };

  // Step 1: Fetch owned games
  const games = await fetchOwnedGames(config);
  if (!options.headless) {
    console.log(`[steam] Found ${games.length} owned games`);
  }

  // Step 2: Process games (sessions + new game detection)
  const gameStats = processGames(ctx, state, games);

  if (!options.headless) {
    if (gameStats.gamesAdded > 0) console.log(`[steam] ${gameStats.gamesAdded} new games detected`);
    if (gameStats.sessionsCreated > 0) console.log(`[steam] ${gameStats.sessionsCreated} new sessions created`);
    if (gameStats.sessionsUpdated > 0) console.log(`[steam] ${gameStats.sessionsUpdated} sessions updated`);
  }

  // Step 3: Process achievements
  const achievementsAdded = await processAchievements(ctx, state, games);
  if (!options.headless && achievementsAdded > 0) {
    console.log(`[steam] ${achievementsAdded} new achievements`);
  }

  // Save sync state
  setSyncState(appDb, "steam", state);

  const totalImported = gameStats.gamesAdded + gameStats.sessionsCreated + achievementsAdded;
  const totalUpdated = gameStats.sessionsUpdated;

  if (!options.headless) {
    console.log(`[steam] Sync complete: ${totalImported} added, ${totalUpdated} updated`);
  }

  return { imported: totalImported, updated: totalUpdated };
}

// ============================================================================
// CLI
// ============================================================================

async function authCommand(): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log("Steam API Setup");
  console.log("================");
  console.log("");
  console.log("1. Get your API key from: https://steamcommunity.com/dev/apikey");
  console.log("2. Find your Steam ID at: https://steamid.io/");
  console.log("");

  const apiKey = (await ask("Steam API Key: ")).trim();
  if (!apiKey) {
    console.error("API key is required");
    rl.close();
    process.exit(1);
  }

  const steamId = (await ask("Steam ID (76561...): ")).trim();
  if (!steamId) {
    console.error("Steam ID is required");
    rl.close();
    process.exit(1);
  }

  rl.close();

  // Validate by fetching player summary
  console.log("\nValidating...");
  const testConfig: SteamConfig = { api_key: apiKey, steam_id: steamId };
  const player = await fetchPlayerSummary(testConfig);
  if (!player) {
    console.error("Failed to fetch player summary. Check your API key and Steam ID.");
    process.exit(1);
  }

  console.log(`\nSuccess! Player: ${player.personaname}`);
  console.log(`Profile: ${player.profileurl}`);

  saveSteamConfig(testConfig);
  console.log(`\nConfig saved to ${CONFIG_PATH}`);
}

async function statusCommand(): Promise<void> {
  const config = loadSteamConfig();
  if (!config) {
    console.log("Steam: Not configured");
    console.log(`Run: bun run src/parsers/steam-api.ts auth`);
    return;
  }

  console.log(`Steam ID: ${config.steam_id}`);
  console.log(`API Key: ${config.api_key.slice(0, 8)}...`);

  try {
    const player = await fetchPlayerSummary(config);
    if (player) {
      console.log(`Player: ${player.personaname}`);
    }
  } catch (e) {
    console.log(`API check failed: ${e instanceof Error ? e.message : e}`);
  }

  const appDb = getAppStateDb();
  const state = getSyncState<SteamSyncState>(appDb, "steam");
  if (state) {
    const gameCount = Object.keys(state.games).length;
    const achievementCount = Object.keys(state.achievements).length;
    const activeSessions = Object.values(state.games).filter((g) => g.current_session_id).length;
    console.log(`\nSync state:`);
    console.log(`  Games tracked: ${gameCount}`);
    console.log(`  Active sessions: ${activeSessions}`);
    console.log(`  Achievement checks: ${achievementCount}`);
    console.log(`  Backfill complete: ${state.backfill_complete}`);
  } else {
    console.log(`\nNo sync state (first sync not run yet)`);
  }
}

if (import.meta.main) {
  const command = process.argv[2];

  switch (command) {
    case "auth":
      await authCommand();
      break;
    case "status":
      await statusCommand();
      break;
    default:
      await syncSteam();
      break;
  }
}
