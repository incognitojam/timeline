import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import { httpRetry } from "../lib/http-retry";
import { createTokenManager, type OAuthTokens } from "../lib/oauth-tokens";
import {
  createOAuth2Client,
  type OAuth2ProviderConfig,
  type OAuth2TokenResponse,
} from "../lib/oauth2-client";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Types (reused from trakt.ts file-based parser)
interface TraktMovie {
  title: string;
  year: number;
  ids: {
    trakt: number;
    slug: string;
    imdb?: string;
    tmdb?: number;
  };
}

interface TraktShow {
  title: string;
  year: number;
  ids: {
    trakt: number;
    slug: string;
    tvdb?: number;
    imdb?: string;
    tmdb?: number;
  };
}

interface TraktEpisode {
  season: number;
  number: number;
  title: string;
  ids: {
    trakt: number;
    tvdb?: number;
    imdb?: string;
    tmdb?: number;
  };
}

interface TraktHistoryItem {
  id: number;
  watched_at: string;
  action: "watch" | "scrobble" | "checkin";
  type: "movie" | "episode";
  movie?: TraktMovie;
  episode?: TraktEpisode;
  show?: TraktShow;
}

// Token data stored in app-state.db sync_state table
interface TraktTokens extends OAuthTokens {
  refresh_token: string;
  created_at: number;
}

// Credentials stored in config file (read-only)
interface TraktConfig {
  client_id: string;
  client_secret: string;
}

// Config
const CONFIG_DIR = join(homedir(), ".config", "timeline");
const CONFIG_PATH = join(CONFIG_DIR, "trakt.json");
const TRAKT_API_URL = "https://api.trakt.tv";

function loadConfig(): TraktConfig {
  // Try config file first, then environment variables
  if (existsSync(CONFIG_PATH)) {
    const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (saved.client_id && saved.client_secret) {
      return {
        client_id: saved.client_id,
        client_secret: saved.client_secret,
      };
    }
  }

  const client_id = process.env.TRAKT_CLIENT_ID;
  const client_secret = process.env.TRAKT_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    throw new Error(
      "Trakt credentials required. Set TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET environment variables, " +
        `or create ${CONFIG_PATH} with client_id and client_secret fields.`
    );
  }

  return { client_id, client_secret };
}

/**
 * Check if Trakt is configured (credentials available).
 */
export function isConfigured(): boolean {
  try {
    loadConfig();
    return true;
  } catch {
    return false;
  }
}

// Custom token extractor for Trakt-specific fields
function traktTokenExtractor(response: OAuth2TokenResponse): TraktTokens {
  if (!response.refresh_token) throw new Error("Trakt token response missing refresh_token");
  return {
    access_token: response.access_token,
    refresh_token: response.refresh_token,
    expires_at: Date.now() + response.expires_in * 1000,
    created_at: response.created_at as number,
  };
}

const TRAKT_OAUTH: OAuth2ProviderConfig = {
  name: "Trakt",
  authUrl: "https://trakt.tv/oauth/authorize",
  tokenUrl: "https://api.trakt.tv/oauth/token",
  authMethod: "body",
  contentType: "json",
};

function createTraktOAuthClient(config: TraktConfig) {
  return createOAuth2Client<TraktTokens>({
    provider: TRAKT_OAUTH,
    credentials: {
      clientId: config.client_id,
      clientSecret: config.client_secret,
    },
    stateKey: "trakt",
    tokenExtractor: traktTokenExtractor,
  });
}

/**
 * A Trakt API request that returned a non-2xx response, carrying the status so
 * the shared retry policy ({@link httpRetry}) can classify it: 5xx retries,
 * 4xx — including 429 — surfaces immediately.
 */
export class TraktApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TraktApiError";
  }
}

// API helpers
export async function traktGet<T>(
  config: TraktConfig,
  tokens: TraktTokens,
  endpoint: string,
  params?: Record<string, string>
): Promise<{ data: T; headers: Headers }> {
  const url = new URL(`${TRAKT_API_URL}${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  return httpRetry(
    async () => {
      const response = await fetch(url.toString(), {
        headers: {
          "Content-Type": "application/json",
          "trakt-api-key": config.client_id,
          "trakt-api-version": "2",
          Authorization: `Bearer ${tokens.access_token}`,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new TraktApiError(
          response.status,
          `Trakt API error ${response.status}: ${error}`,
        );
      }

      return { data: (await response.json()) as T, headers: response.headers };
    });
}

async function traktPost<T>(
  config: TraktConfig,
  tokens: TraktTokens,
  endpoint: string,
  body: unknown
): Promise<{ data: T; headers: Headers }> {
  const response = await fetch(`${TRAKT_API_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "trakt-api-key": config.client_id,
      "trakt-api-version": "2",
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Trakt API error ${response.status}: ${error}`);
  }

  return { data: await response.json(), headers: response.headers };
}

function formatEpisodeTitle(show: TraktShow, episode: TraktEpisode): string {
  const seasonEp = `S${String(episode.season).padStart(2, "0")}E${String(episode.number).padStart(2, "0")}`;
  return `${show.title} - ${seasonEp}: ${episode.title}`;
}

// Fetch history with pagination
export async function fetchHistory(
  config: TraktConfig,
  tokens: TraktTokens,
  options: {
    startAt?: string;
    endAt?: string;
    quiet?: boolean;
  } = {}
): Promise<TraktHistoryItem[]> {
  const { startAt, endAt, quiet = false } = options;
  const allItems: TraktHistoryItem[] = [];
  let page = 1;
  const limit = 100; // Max reasonable limit
  let totalPages = 1;

  if (!quiet) {
    console.log(startAt ? `Fetching history since ${startAt}...` : "Fetching full history...");
  }

  while (page <= totalPages) {
    const params: Record<string, string> = {
      page: String(page),
      limit: String(limit),
    };
    if (startAt) {
      params.start_at = startAt;
    }
    if (endAt) {
      params.end_at = endAt;
    }

    const { data, headers } = await traktGet<TraktHistoryItem[]>(
      config,
      tokens,
      "/sync/history",
      params
    );

    allItems.push(...data);

    // Get pagination info from headers
    const pageCount = headers.get("X-Pagination-Page-Count");
    if (pageCount) {
      totalPages = parseInt(pageCount, 10);
    }

    if (data.length < limit) {
      break; // No more data
    }

    page++;

    // Small delay to avoid rate limiting
    if (page <= totalPages) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (!quiet) {
    console.log(`Fetched ${allItems.length} items across ${page} page(s)`);
  }
  return allItems;
}

// Get latest timestamp from DB for incremental sync
function getLatestTimestamp(db: Database): string | null {
  const result = db.query<{ latest: string | null }, []>(`
    SELECT MAX(timestamp) as latest FROM events WHERE source = 'trakt'
  `).get();
  return result?.latest || null;
}

/**
 * Insert a single Trakt history item into the database.
 * Returns true if inserted, false if skipped (duplicate or invalid).
 */
export function insertTraktEvent(
  db: Database,
  item: TraktHistoryItem,
  sourceAccount: string,
  importBatch: string
): boolean {
  const sourceId = `${item.id}`;
  let eventType: string;
  let title: string;
  let content: string | null = null;
  const tags: string[] = [item.action];

  if (item.type === "movie" && item.movie) {
    eventType = "trakt:movie";
    title = `${item.movie.title} (${item.movie.year})`;
    tags.push("movie");
    if (item.movie.ids.imdb) {
      content = `IMDB: ${item.movie.ids.imdb}`;
    }
  } else if (item.type === "episode" && item.episode && item.show) {
    eventType = "trakt:episode";
    title = formatEpisodeTitle(item.show, item.episode);
    tags.push("tv", `show:${item.show.ids.slug}`);
    content = `${item.show.title}`;
  } else {
    return false; // Unknown type
  }

  try {
    const result = db.run(
      `INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, tags, raw_data, import_batch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "trakt",
        sourceId,
        sourceAccount,
        eventType,
        item.watched_at,
        title,
        content,
        JSON.stringify(tags),
        JSON.stringify(item),
        importBatch,
      ]
    );
    return result.changes > 0;
  } catch {
    return false;
  }
}

export interface TraktSyncStats {
  imported: number;
  skipped: number;
  movies: number;
  episodes: number;
}

export async function syncTrakt(
  sourceAccount: string,
  options: { headless?: boolean; full?: boolean } = {}
): Promise<TraktSyncStats> {
  const config = loadConfig();
  const oauth = createTraktOAuthClient(config);
  const tokens = await oauth.ensureValidToken({ headless: options.headless });

  const db = getDb();
  initDb(db);

  // Check for incremental sync with lookback window
  // Trakt allows retroactively adding watches with past dates, so we look back
  // 30 days to catch entries added since the last sync.
  // INSERT OR IGNORE handles duplicates from the overlap.
  let startAt: string | undefined;

  if (options.full) {
    console.log("Full sync (forced)");
  } else {
    const latestTimestamp = getLatestTimestamp(db);
    const lookbackDays = 30;

    if (latestTimestamp) {
      const latest = new Date(latestTimestamp);
      latest.setDate(latest.getDate() - lookbackDays);
      startAt = latest.toISOString();
      console.log(`Incremental sync from ${startAt} (${lookbackDays}-day lookback)`);
    } else {
      console.log("Full sync (no existing data)");
    }
  }

  const items = await fetchHistory(config, tokens, { startAt });

  if (items.length === 0) {
    console.log("No new items to import");
    db.close();
    return { imported: 0, skipped: 0, movies: 0, episodes: 0 };
  }

  const importBatch = `trakt-api-${sourceAccount}-${Date.now()}`;
  const stats: TraktSyncStats = { imported: 0, skipped: 0, movies: 0, episodes: 0 };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: TraktHistoryItem[]) => {
    for (const item of items) {
      const sourceId = `${item.id}`;
      let eventType: string;
      let title: string;
      let content: string | null = null;
      const tags: string[] = [item.action];

      if (item.type === "movie" && item.movie) {
        eventType = "trakt:movie";
        title = `${item.movie.title} (${item.movie.year})`;
        tags.push("movie");
        if (item.movie.ids.imdb) {
          content = `IMDB: ${item.movie.ids.imdb}`;
        }
        stats.movies++;
      } else if (item.type === "episode" && item.episode && item.show) {
        eventType = "trakt:episode";
        title = formatEpisodeTitle(item.show, item.episode);
        tags.push("tv", `show:${item.show.ids.slug}`);
        content = `${item.show.title}`;
        stats.episodes++;
      } else {
        stats.skipped++;
        continue;
      }

      try {
        const result = insert.run(
          "trakt",
          sourceId,
          sourceAccount,
          eventType,
          item.watched_at,
          title,
          content,
          JSON.stringify(tags),
          JSON.stringify(item),
          importBatch
        );
        // Bun's run() returns { changes, lastInsertRowid }
        if (result.changes > 0) {
          stats.imported++;
        } else {
          stats.skipped++;
        }
      } catch {
        stats.skipped++;
      }
    }
  });

  insertMany(items);

  console.log(`\nImport complete:`);
  console.log(`  Imported: ${stats.imported}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Movies: ${stats.movies}, Episodes: ${stats.episodes}`);
  console.log(`  Batch ID: ${importBatch}`);

  db.close();
  return stats;
}

// ============================================
// Exported API functions for trakt-correct tool
// ============================================

// Re-export for use by correction tool
export type { TraktHistoryItem };

/**
 * Fetch history entries within a time window (handles auth automatically).
 * Useful for fetching newly-added entries after correction.
 */
export async function fetchHistoryWindow(
  startAt: string,
  endAt: string
): Promise<TraktHistoryItem[]> {
  const config = loadConfig();
  const oauth = createTraktOAuthClient(config);
  const tokens = await oauth.ensureValidToken();
  return fetchHistory(config, tokens, { startAt, endAt, quiet: true });
}

export interface TraktHistoryAddEpisode {
  ids: { trakt?: number; tvdb?: number; imdb?: string; tmdb?: number };
  watched_at: string;
}

export interface TraktHistoryAddMovie {
  ids: { trakt?: number; imdb?: string; tmdb?: number };
  watched_at: string;
}

export interface TraktHistoryRemoveResponse {
  deleted: { movies: number; episodes: number };
  not_found: { movies: unknown[]; episodes: unknown[]; ids: number[] };
}

export interface TraktHistoryAddResponse {
  added: { movies: number; episodes: number };
  not_found: { movies: unknown[]; episodes: unknown[] };
}

export interface TraktEpisodeExtended {
  season: number;
  number: number;
  title: string;
  ids: { trakt: number; tvdb?: number; imdb?: string; tmdb?: number };
  first_aired: string | null;
  runtime: number;
  overview: string | null;
}

/**
 * Remove history entries by their history IDs.
 * POST /sync/history/remove with body: { "ids": [...] }
 */
export async function removeFromHistory(historyIds: number[]): Promise<TraktHistoryRemoveResponse> {
  const config = loadConfig();
  const oauth = createTraktOAuthClient(config);
  const tokens = await oauth.ensureValidToken();

  const { data } = await traktPost<TraktHistoryRemoveResponse>(
    config,
    tokens,
    "/sync/history/remove",
    { ids: historyIds }
  );

  return data;
}

/**
 * Add items to history with custom watched_at timestamps.
 * POST /sync/history with body: { "episodes": [...], "movies": [...] }
 */
export async function addToHistory(options: {
  episodes?: TraktHistoryAddEpisode[];
  movies?: TraktHistoryAddMovie[];
}): Promise<TraktHistoryAddResponse> {
  const config = loadConfig();
  const oauth = createTraktOAuthClient(config);
  const tokens = await oauth.ensureValidToken();

  const { data } = await traktPost<TraktHistoryAddResponse>(
    config,
    tokens,
    "/sync/history",
    options
  );

  return data;
}

/**
 * Get extended episode details including air date.
 * GET /shows/{id}/seasons/{season}/episodes/{episode}?extended=full
 */
export async function getEpisode(
  showIdOrSlug: string | number,
  season: number,
  episode: number
): Promise<TraktEpisodeExtended> {
  const config = loadConfig();
  const oauth = createTraktOAuthClient(config);
  const tokens = await oauth.ensureValidToken();

  const { data } = await traktGet<TraktEpisodeExtended>(
    config,
    tokens,
    `/shows/${showIdOrSlug}/seasons/${season}/episodes/${episode}`,
    { extended: "full" }
  );

  return data;
}

/**
 * Ensure we have valid tokens (for use by external tools)
 */
export async function ensureAuthenticated(): Promise<void> {
  const config = loadConfig();
  const oauth = createTraktOAuthClient(config);
  await oauth.ensureValidToken();
}

function showStatus(): void {
  const config = loadConfig();
  const oauth = createTraktOAuthClient(config);
  const tokens = oauth.getTokens();

  console.log("Trakt API Status");
  console.log("=".repeat(40));
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
    console.log(`Refresh token: present`);
  } else {
    console.log("Token: not authenticated");
    console.log("  Run without arguments to authenticate");
  }
}

// CLI
if (import.meta.main) {
  const command = process.argv[2];

  if (command === "status") {
    showStatus();
  } else if (command === "reset") {
    createTokenManager("trakt").clear();
    console.log("Tokens cleared from database.");

    // Also delete config file if it exists
    if (existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
      console.log("Config file cleared.");
    }
  } else if (command === "auth") {
    const config = loadConfig();
    const oauth = createTraktOAuthClient(config);

    console.log("Authenticating with Trakt...");
    const tokens = await oauth.ensureValidToken();

    // Test auth by fetching user settings
    const { data } = await traktGet<{ user: { username: string } }>(
      config,
      tokens,
      "/users/settings"
    );
    console.log(`Authenticated as: ${data.user.username}`);
  } else if (command === "help" || command === "-h" || command === "--help") {
    console.log(`Trakt API Parser

Usage:
  bun run src/parsers/trakt-api.ts <account>          # Sync watch history
  bun run src/parsers/trakt-api.ts --full <account>   # Full sync (re-fetch all history)
  bun run src/parsers/trakt-api.ts auth         # Authenticate only (no sync)
  bun run src/parsers/trakt-api.ts status       # Check auth status
  bun run src/parsers/trakt-api.ts reset        # Clear credentials

On first run, opens browser for Trakt OAuth authentication.
Subsequent runs use saved tokens with auto-refresh.
`);
  } else {
    const full = process.argv.includes("--full");
    const account = command === "--full" ? process.argv[3] : command;
    if (!account) {
      throw new Error(
        "Trakt account name is required. Pass <account> or run with --help."
      );
    }
    await syncTrakt(account, { full });
  }
}
