import { Database } from "bun:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAppStateDb, setSyncState } from "../db/app-state";
import { getDb, initDb } from "../db/schema";
import { httpRetry } from "../lib/http-retry";
import {
  createOAuth2Client,
  type OAuth2ProviderConfig,
  type OAuth2TokenResponse,
} from "../lib/oauth2-client";
import { createTokenManager, type OAuthTokens } from "../lib/oauth-tokens";

interface SwarmConfig {
  client_id: string;
  client_secret: string;
}

interface SwarmTokens extends OAuthTokens {
  backfill_complete?: boolean;
}

interface SwarmUser {
  id: string;
  firstName?: string;
  lastName?: string;
}

interface SwarmVenue {
  id?: string;
  name?: string;
  location?: {
    lat?: number;
    lng?: number;
    address?: string;
    city?: string;
    country?: string;
    formattedAddress?: string[];
  };
  categories?: Array<{ name: string }>;
}

export interface SwarmCheckin {
  id?: string;
  createdAt?: number;
  timeZoneOffset?: number;
  shout?: string;
  venue?: SwarmVenue;
  with?: SwarmUser[];
}

interface CheckinsResponse {
  response: {
    checkins: {
      count: number;
      items: SwarmCheckin[];
    };
  };
}

interface UserResponse {
  response: { user: SwarmUser };
}

const CONFIG_PATH = join(homedir(), ".config", "timeline", "swarm.json");
const SWARM_API_URL = "https://api.foursquare.com/v2";
const STATE_KEY = "swarm";
export const SWARM_PAGE_LIMIT = 250;

function loadConfig(): SwarmConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Swarm credentials required. Create ${CONFIG_PATH} with client_id and client_secret fields.`);
  }

  const saved: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  if (
    typeof saved !== "object" ||
    saved === null ||
    !("client_id" in saved) ||
    !("client_secret" in saved) ||
    typeof saved.client_id !== "string" ||
    typeof saved.client_secret !== "string" ||
    !saved.client_id ||
    !saved.client_secret
  ) {
    throw new Error(`Swarm credentials in ${CONFIG_PATH} must include client_id and client_secret.`);
  }

  return { client_id: saved.client_id, client_secret: saved.client_secret };
}

function swarmTokenExtractor(response: OAuth2TokenResponse): SwarmTokens {
  // Foursquare returns no expires_in or refresh_token. Preserve a numeric field
  // for the shared token shape while explicitly marking it as non-expiring.
  return { access_token: response.access_token, expires_at: 0, non_expiring: true };
}

const SWARM_OAUTH: OAuth2ProviderConfig = {
  name: "Swarm",
  authUrl: "https://foursquare.com/oauth2/authenticate",
  tokenUrl: "https://foursquare.com/oauth2/access_token",
  authMethod: "body",
  contentType: "form",
};

function createSwarmOAuthClient(config: SwarmConfig) {
  return createOAuth2Client<SwarmTokens>({
    provider: SWARM_OAUTH,
    credentials: { clientId: config.client_id, clientSecret: config.client_secret },
    stateKey: STATE_KEY,
    tokenExtractor: swarmTokenExtractor,
  });
}

export class SwarmApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errorType?: string,
  ) {
    super(message);
    this.name = "SwarmApiError";
  }
}

export class SwarmSyncError extends Error {
  constructor(
    readonly stats: SwarmSyncStats,
    readonly originalError: unknown,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError));
    this.name = "SwarmSyncError";
  }
}

function getErrorType(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "meta" in parsed &&
      typeof parsed.meta === "object" &&
      parsed.meta !== null &&
      "errorType" in parsed.meta &&
      typeof parsed.meta.errorType === "string"
    ) {
      return parsed.meta.errorType;
    }
  } catch {}
  return undefined;
}

async function swarmGet<T>(
  tokens: SwarmTokens,
  endpoint: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${SWARM_API_URL}${endpoint}`);
  url.searchParams.set("oauth_token", tokens.access_token);
  url.searchParams.set("v", "20250101");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  return httpRetry(
    async () => {
      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.text();
        const errorType = getErrorType(body);
        if (response.status === 402) {
          throw new SwarmApiError(
            402,
            "Foursquare returned 402 Payment Required for your own check-ins. This is a known Foursquare-side issue; contact Foursquare support before retrying.",
          );
        }
        throw new SwarmApiError(response.status, `Foursquare API error ${response.status}: ${body}`, errorType);
      }
      return (await response.json()) as T;
    },
    {
      isTransient: (error) =>
        error instanceof TypeError ||
        (error instanceof SwarmApiError && (
          error.status === 429 ||
          error.status >= 500 ||
          (error.status === 403 && error.errorType === "rate_limit_exceeded")
        )),
    },
  );
}

async function getCurrentUser(tokens: SwarmTokens): Promise<SwarmUser> {
  const data = await swarmGet<UserResponse>(tokens, "/users/self");
  return data.response.user;
}

function displayName(user: SwarmUser): string | null {
  const name = [user.firstName, user.lastName].filter((part): part is string => Boolean(part?.trim())).join(" ");
  return name || null;
}

/** Insert a Swarm check-in and return whether a new event row was created. */
export function insertSwarmEvent(
  db: Database,
  item: SwarmCheckin,
  sourceAccount: string,
  importBatch: string,
): boolean {
  if (typeof item.id !== "string" || !item.id.trim() || typeof item.createdAt !== "number" || !Number.isFinite(item.createdAt)) {
    console.debug(`Skipping Swarm check-in with invalid id or createdAt: id=${item.id ?? "missing"}, createdAt=${item.createdAt ?? "missing"}`);
    return false;
  }

  const date = new Date(item.createdAt * 1000);
  if (Number.isNaN(date.valueOf())) {
    console.debug(`Skipping Swarm check-in with invalid createdAt: ${item.createdAt}`);
    return false;
  }

  const venueName = item.venue?.name?.trim() || null;
  const people = item.with
    ?.map(displayName)
    .filter((name): name is string => name !== null);
  const tags = item.venue?.categories?.map((category) => category.name);
  const row = db.query<{ id: number }, [
    string, string, string, string, string, string | null, number | null, number | null, string | null, string | null, string | null, string, string,
  ]>(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, title, content,
      latitude, longitude, location_name, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, 'location:visit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    "swarm",
    item.id,
    sourceAccount,
    date.toISOString(),
    venueName ? `Checked in at ${venueName}` : "Checked in",
    item.shout ?? null,
    item.venue?.location?.lat ?? null,
    item.venue?.location?.lng ?? null,
    venueName,
    people?.length ? JSON.stringify(people) : null,
    tags?.length ? JSON.stringify(tags) : null,
    JSON.stringify(item),
    importBatch,
  );
  return row !== null;
}

export interface SwarmSyncStats {
  imported: number;
  skipped: number;
}

interface SyncSwarmCheckinsOptions {
  db: Database;
  sourceAccount: string;
  tokens: SwarmTokens;
  fetchPage: (offset: number) => Promise<SwarmCheckin[]>;
  full?: boolean;
}

export async function syncSwarmCheckins({
  db,
  sourceAccount,
  tokens,
  fetchPage,
  full: forceFull = false,
}: SyncSwarmCheckinsOptions): Promise<SwarmSyncStats> {
  const importBatch = `swarm-api-${sourceAccount}-${Date.now()}`;
  const stats: SwarmSyncStats = { imported: 0, skipped: 0 };
  const full = forceFull || !tokens.backfill_complete;

  console.log(full ? "Full sync" : "Incremental sync");
  try {
    for (let offset = 0; ; offset += SWARM_PAGE_LIMIT) {
      const items = await fetchPage(offset);
      let insertedThisPage = 0;
      const insertPage = db.transaction((page: SwarmCheckin[]) => {
        for (const item of page) {
          if (insertSwarmEvent(db, item, sourceAccount, importBatch)) {
            insertedThisPage++;
            stats.imported++;
          } else {
            stats.skipped++;
          }
        }
      });
      insertPage(items);

      if (items.length < SWARM_PAGE_LIMIT) {
        if (full) {
          setSyncState(getAppStateDb(), STATE_KEY, { ...tokens, backfill_complete: true });
        }
        break;
      }
      if (!full && insertedThisPage === 0) break;
    }
  } catch (error) {
    throw new SwarmSyncError(stats, error);
  }

  console.log(`Imported ${stats.imported}, skipped ${stats.skipped}`);
  return stats;
}

export async function syncSwarm(
  options: { headless?: boolean; full?: boolean } = {},
): Promise<SwarmSyncStats> {
  const config = loadConfig();
  const oauth = createSwarmOAuthClient(config);
  const tokens = await oauth.ensureValidToken({ headless: options.headless });
  const user = await getCurrentUser(tokens);
  const sourceAccount = user.id;
  const db = getDb();
  initDb(db);
  try {
    return await syncSwarmCheckins({
      db,
      sourceAccount,
      tokens,
      full: options.full,
      fetchPage: async (offset) => {
        const data = await swarmGet<CheckinsResponse>(tokens, "/users/self/checkins", {
          limit: String(SWARM_PAGE_LIMIT),
          offset: String(offset),
        });
        return data.response.checkins.items;
      },
    });
  } finally {
    db.close();
  }
}

function showStatus(): void {
  const config = loadConfig();
  const tokens = createSwarmOAuthClient(config).getTokens();
  console.log("Swarm API Status");
  console.log("=".repeat(40));
  console.log(`Client ID: ${config.client_id.substring(0, 8)}...`);
  console.log(tokens ? "Token: valid (long-lived)" : "Token: not authenticated");
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "auth") {
    const config = loadConfig();
    const tokens = await createSwarmOAuthClient(config).ensureValidToken();
    const user = await getCurrentUser(tokens);
    console.log(`Authenticated as: ${displayName(user) ?? user.id}`);
  } else if (command === "status") {
    showStatus();
  } else if (command === "reset") {
    createTokenManager(STATE_KEY).clear();
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    console.log("Tokens and Swarm credentials cleared.");
  } else if (command === "help" || command === "-h" || command === "--help") {
    console.log(`Swarm API Parser

Usage:
  bun run src/parsers/swarm-api.ts          # Sync check-ins
  bun run src/parsers/swarm-api.ts --full   # Re-fetch all check-ins
  bun run src/parsers/swarm-api.ts auth     # Authenticate only
  bun run src/parsers/swarm-api.ts status   # Check auth status
  bun run src/parsers/swarm-api.ts reset    # Clear credentials
`);
  } else {
    await syncSwarm({ full: process.argv.includes("--full") });
  }
}
