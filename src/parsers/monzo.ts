import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import {
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { createTokenManager, type OAuthTokens } from "../lib/oauth-tokens";
import {
  createOAuth2Client,
  type OAuth2Client,
  type OAuth2ProviderConfig,
} from "../lib/oauth2-client";
import { OAUTH_CALLBACK_PORT } from "../lib/oauth-callback";
import { getMonzoAuthCommand } from "../runtime-paths";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Types
interface MonzoAccount {
  id: string;
  description: string;
  created: string;
  type?: string;
  closed?: boolean;
}

interface MonzoMerchant {
  id: string;
  group_id: string;
  name: string;
  logo: string;
  emoji: string;
  category: string;
  online: boolean;
  atm: boolean;
  address: {
    short_formatted: string;
    formatted: string;
    address: string;
    city: string;
    region: string;
    country: string;
    postcode: string;
    latitude: number;
    longitude: number;
  };
}

export interface MonzoTransaction {
  id: string;
  created: string;
  description: string;
  amount: number;
  currency: string;
  merchant: MonzoMerchant | string | null;
  notes: string;
  metadata: Record<string, string>;
  category: string;
  is_load: boolean;
  settled: string;
  local_amount: number;
  local_currency: string;
  decline_reason?: string;
  counterparty?: {
    name?: string;
    user_id?: string;
    account_id?: string;
    preferred_name?: string;
  };
}

/**
 * Extract counterparty identity from a Monzo transaction.
 *
 * Only mints an identity for `user_*` counterparties — stable Monzo user IDs
 * that recur across transactions, so they're durable identities worth linking
 * to a contact.
 *
 * `anonuser_*` IDs are ephemeral: Monzo issues a fresh one for every
 * transaction to/from an out-of-network counterparty (e.g. faster payments),
 * so the same person never shares an ID across transactions. Minting an
 * identity per `anonuser_*` floods the identities graph with single-use tokens
 * that can never aggregate (a single contact can accumulate hundreds of them). We skip them
 * entirely; the counterparty name is preserved on the event title and raw_data.
 * Associating these transactions with a contact would need a name-based method,
 * not the identity graph.
 */
export function extractCounterpartyIdentity(
  tx: MonzoTransaction
): { identifier: string; identity: UpsertIdentityOptions } | null {
  const cp = tx.counterparty;
  if (!cp?.user_id) return null;
  if (!cp.user_id.startsWith("user_")) return null;

  const displayName = cp.preferred_name || cp.name;
  return {
    identifier: formatIdentifier("monzo", cp.user_id),
    identity: {
      platform: "monzo" as const,
      platformId: cp.user_id,
      displayName: displayName || undefined,
    },
  };
}

// Token data stored in app-state.db sync_state table
interface MonzoTokens extends OAuthTokens {
  refresh_token?: string;
}

// Credentials stored in config file (read-only)
interface MonzoConfig {
  credentials: { client_id: string; client_secret: string };
  selected_accounts?: string[];
}

// Config
const CONFIG_DIR = join(homedir(), ".config", "timeline");
const CONFIG_PATH = join(CONFIG_DIR, "monzo.json");
const MONZO_API_URL = "https://api.monzo.com";

function loadConfig(): MonzoConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  return {
    credentials: saved.credentials,
    selected_accounts: saved.selected_accounts,
  };
}

function saveConfig(config: MonzoConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const MONZO_OAUTH: OAuth2ProviderConfig = {
  name: "Monzo",
  authUrl: "https://auth.monzo.com",
  tokenUrl: "https://api.monzo.com/oauth2/token",
  authMethod: "body",
  contentType: "form",
};

function createMonzoOAuthClient(config: MonzoConfig): OAuth2Client<MonzoTokens> {
  return createOAuth2Client<MonzoTokens>({
    provider: {
      ...MONZO_OAUTH,
      // Monzo uses a random state parameter for CSRF protection
      extraAuthParams: {
        state: Math.random().toString(36).substring(7),
      },
    },
    credentials: {
      clientId: config.credentials.client_id,
      clientSecret: config.credentials.client_secret,
    },
    stateKey: "monzo",
    redirectUri: `http://localhost:${OAUTH_CALLBACK_PORT}/callback`,
  });
}

// API helpers
async function monzoGet<T>(token: string, endpoint: string): Promise<T> {
  const response = await fetch(`${MONZO_API_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error ${response.status}: ${error}`);
  }

  return response.json();
}

interface MonzoPot {
  id: string;
  name: string;
  deleted: boolean;
}

async function waitForSCA(token: string): Promise<MonzoAccount[]> {
  console.log("Fetching accounts (approve in Monzo app if prompted)...");

  for (let i = 0; i < 60; i++) {
    try {
      const response = await monzoGet<{ accounts: MonzoAccount[] }>(token, "/accounts");
      return response.accounts.filter((a) => !a.closed);
    } catch (e: any) {
      if (e.message?.includes("403")) {
        if (i === 0) console.log("⏳ Waiting for approval in Monzo app...");
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        throw e;
      }
    }
  }
  throw new Error("Timed out waiting for Monzo app approval");
}

async function fetchPots(token: string, accountId: string): Promise<Map<string, string>> {
  try {
    const response = await monzoGet<{ pots: MonzoPot[] }>(token, `/pots?current_account_id=${accountId}`);
    const potMap = new Map<string, string>();
    for (const pot of response.pots) {
      potMap.set(pot.id, pot.name);
    }
    return potMap;
  } catch {
    return new Map();
  }
}

// Transaction fetching
async function fetchTransactionsFull(token: string, accountId: string): Promise<MonzoTransaction[]> {
  const allTransactions: MonzoTransaction[] = [];
  const now = new Date();
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const earliest = new Date("2015-01-01T00:00:00Z");

  let chunkEnd = now;
  let chunkStart = new Date(chunkEnd.getTime() - oneYear);
  let emptyChunks = 0;

  while (chunkEnd > earliest && emptyChunks < 2) {
    if (chunkStart < earliest) chunkStart = earliest;

    const since = chunkStart.toISOString();
    const before = chunkEnd.toISOString();
    let url = `/transactions?account_id=${accountId}&expand[]=merchant&since=${since}&before=${before}`;
    let chunkTxs: MonzoTransaction[] = [];

    let hasMore = true;
    while (hasMore) {
      const paginatedUrl = chunkTxs.length > 0
        ? `/transactions?account_id=${accountId}&expand[]=merchant&since=${chunkTxs[chunkTxs.length - 1].id}&before=${before}`
        : url;

      const response = await monzoGet<{ transactions: MonzoTransaction[] }>(token, paginatedUrl);
      if (response.transactions.length === 0) {
        hasMore = false;
      } else {
        chunkTxs.push(...response.transactions);
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    if (chunkTxs.length === 0) {
      emptyChunks++;
    } else {
      emptyChunks = 0;
      allTransactions.push(...chunkTxs);
    }

    chunkEnd = new Date(chunkStart.getTime());
    chunkStart = new Date(chunkEnd.getTime() - oneYear);
  }

  return allTransactions;
}

async function fetchTransactionsQuick(token: string, accountId: string): Promise<MonzoTransaction[]> {
  const allTransactions: MonzoTransaction[] = [];
  const since = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString();
  let url = `/transactions?account_id=${accountId}&expand[]=merchant&since=${since}`;

  let hasMore = true;
  while (hasMore) {
    const paginatedUrl = allTransactions.length > 0
      ? `/transactions?account_id=${accountId}&expand[]=merchant&since=${allTransactions[allTransactions.length - 1].id}`
      : url;

    const response = await monzoGet<{ transactions: MonzoTransaction[] }>(token, paginatedUrl);
    if (response.transactions.length === 0) {
      hasMore = false;
    } else {
      allTransactions.push(...response.transactions);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return allTransactions;
}

// Check if we need full refresh.
//
// Quick sync only sees the last 90 days of transactions; full refresh requires
// fresh OAuth (the SCA approval grants temporary unrestricted history access).
// We trigger full refresh when the most recent transaction across ALL accounts
// is older than 89 days — that means the next quick sync would leave a gap
// older than the 90-day window can fill. Per-account checks would falsely
// trigger on dormant accounts that simply have no recent activity.
function checkNeedsFullRefresh(_accounts: MonzoAccount[]): boolean {
  const db = getDb();
  try {
    const latest = db.query<{ newest: string | null }, []>(
      `SELECT MAX(timestamp) as newest FROM events WHERE source = 'monzo'`
    ).get();

    if (!latest?.newest) return true;

    const ninetyDaysAgo = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString();
    return latest.newest < ninetyDaysAgo;
  } finally {
    db.close();
  }
}

// Transaction processing
function formatAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency,
  }).format(Math.abs(amount) / 100);
}

function getTransactionTitle(tx: MonzoTransaction, potNames: Map<string, string>): string {
  const amount = formatAmount(tx.amount, tx.currency);
  const sign = tx.amount >= 0 ? "+" : "-";

  if (typeof tx.merchant === "object" && tx.merchant?.name) {
    return `${sign}${amount} at ${tx.merchant.name}`;
  }
  if (tx.counterparty?.name) {
    return `${sign}${amount} ${tx.amount >= 0 ? "from" : "to"} ${tx.counterparty.name}`;
  }

  // Replace pot IDs with names in description
  let desc = tx.description;
  for (const [potId, potName] of potNames) {
    desc = desc.replace(potId, potName);
  }

  return `${sign}${amount} - ${desc}`;
}

function getTransactionType(tx: MonzoTransaction): string {
  if (tx.decline_reason) return "transaction:declined";
  if (tx.is_load) return "transaction:topup";
  if (tx.amount > 0) return "transaction:credit";

  const cat = tx.category?.toLowerCase();
  if (cat === "transport") return "transaction:transport";
  if (cat === "groceries") return "transaction:groceries";
  if (cat === "eating_out") return "transaction:food";
  if (cat === "entertainment") return "transaction:entertainment";
  if (cat === "shopping") return "transaction:shopping";
  if (cat === "bills") return "transaction:bills";
  if (cat === "cash") return "transaction:cash";

  return "transaction";
}

// Main sync function
async function sync(opts: { headless?: boolean } = {}): Promise<void> {
  const headless = opts.headless ?? false;
  let config = loadConfig();

  // Get credentials if needed
  if (!config?.credentials) {
    if (headless) {
      throw new Error(
        `Monzo not configured. Run \`${getMonzoAuthCommand()}\` interactively first.`
      );
    }
    console.log("=== Monzo Setup ===\n");
    console.log("1. Go to https://developers.monzo.com/");
    console.log("2. Create OAuth client with redirect URI: http://localhost:8742/callback\n");

    process.stdout.write("Client ID: ");
    const clientId = (await new Promise<string>((r) => {
      process.stdin.once("data", (d) => r(d.toString().trim()));
    }));

    process.stdout.write("Client Secret: ");
    const clientSecret = (await new Promise<string>((r) => {
      process.stdin.once("data", (d) => r(d.toString().trim()));
    }));

    config = { credentials: { client_id: clientId, client_secret: clientSecret } };
    saveConfig(config);
    console.log();
  }

  // Create OAuth client
  const oauth = createMonzoOAuthClient(config);

  // Try to list accounts with existing token
  let tokens = oauth.getTokens();
  let accounts: MonzoAccount[] | null = null;
  let needsFullRefresh = false;

  // Check if token is expired or about to expire (5 min buffer)
  const bufferMs = 5 * 60 * 1000;
  const tokenExpired = !tokens || Date.now() >= tokens.expires_at - bufferMs;

  if (tokens && !tokenExpired) {
    try {
      accounts = await waitForSCA(tokens.access_token);
      needsFullRefresh = checkNeedsFullRefresh(accounts);
    } catch (e) {
      // Token invalid, try to refresh
      console.log("Token invalid, attempting refresh...");
      tokens = await oauth.refresh(tokens, { silent: true });
      if (tokens) {
        try {
          accounts = await waitForSCA(tokens.access_token);
          needsFullRefresh = checkNeedsFullRefresh(accounts);
        } catch {
          tokens = null;
        }
      }
    }
  } else if (tokens && tokenExpired) {
    // Token expired, try to refresh first
    console.log("Token expired, attempting refresh...");
    const refreshed = await oauth.refresh(tokens, { silent: true });
    if (refreshed) {
      tokens = refreshed;
      try {
        accounts = await waitForSCA(tokens.access_token);
        needsFullRefresh = checkNeedsFullRefresh(accounts);
      } catch {
        tokens = null;
      }
    } else {
      tokens = null;
    }
  }

  // If no valid token or needs full refresh, do OAuth
  if (!tokens || needsFullRefresh) {
    if (headless) {
      const reason = !tokens
        ? "no valid token"
        : "full refresh required (most recent transaction is >89 days old)";
      throw new Error(
        `Monzo requires interactive OAuth (${reason}). Run \`${getMonzoAuthCommand()}\` to re-authenticate.`
      );
    }
    if (needsFullRefresh && accounts) {
      console.log("Full refresh needed - please log in again for complete history access\n");
    }
    tokens = await oauth.authorize();
    accounts = await waitForSCA(tokens.access_token);
    needsFullRefresh = true; // Fresh auth = can get full history
  }

  // accounts is guaranteed to be set at this point
  if (!accounts) {
    throw new Error("Failed to get Monzo accounts");
  }

  console.log(`Found ${accounts.length} account(s)\n`);

  // Fetch pots for all accounts (for translating pot IDs to names)
  console.log("Fetching pots...");
  const allPotNames = new Map<string, string>();
  for (const account of accounts) {
    const pots = await fetchPots(tokens.access_token, account.id);
    for (const [id, name] of pots) {
      allPotNames.set(id, name);
    }
  }

  // Fetch transactions
  console.log(needsFullRefresh ? "Fetching full history..." : "Fetching last 90 days...");

  const startTime = Date.now();
  const token = tokens.access_token;
  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        const txs = needsFullRefresh
          ? await fetchTransactionsFull(token, account.id)
          : await fetchTransactionsQuick(token, account.id);
        return { account, transactions: txs, error: null };
      } catch (e: any) {
        return { account, transactions: [], error: e.message };
      }
    })
  );

  console.log(`Fetched in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

  // Insert into database
  const db = getDb();
  initDb(db);

  const importBatch = `monzo-${Date.now()}`;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, latitude, longitude, location_name,
      people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;
  const allIdentities: UpsertIdentityOptions[] = [];

  for (const { account, transactions, error } of results) {
    if (error) {
      console.log(`${account.description}: ✗ ${error}`);
      continue;
    }

    const insertMany = db.transaction((txs: MonzoTransaction[]) => {
      for (const tx of txs) {
        if (tx.decline_reason) {
          totalSkipped++;
          continue;
        }

        const title = getTransactionTitle(tx, allPotNames);
        const type = getTransactionType(tx);

        let lat: number | null = null;
        let lng: number | null = null;
        let locName: string | null = null;

        if (typeof tx.merchant === "object" && tx.merchant?.address) {
          lat = tx.merchant.address.latitude || null;
          lng = tx.merchant.address.longitude || null;
          locName = tx.merchant.address.short_formatted || null;
        }

        const tags: string[] = [];
        if (tx.category) tags.push(tx.category);
        if (account.type) tags.push(account.type);

        // Extract counterparty for P2P transactions
        const counterpartyData = extractCounterpartyIdentity(tx);
        let people: string[] | null = null;
        if (counterpartyData) {
          people = [counterpartyData.identifier];
          allIdentities.push(counterpartyData.identity);
        }

        try {
          insert.run(
            "monzo", tx.id, account.type || "unknown", type, tx.created,
            title, title, lat, lng, locName,
            people ? JSON.stringify(people) : null,
            JSON.stringify(tags), JSON.stringify({ ...tx, account_id: account.id }), importBatch
          );
          totalImported++;
        } catch {
          totalSkipped++;
        }
      }
    });

    insertMany(transactions);
    console.log(`${account.description} (${account.type}): ${transactions.length} transactions`);
  }

  // Batch upsert all collected identities (deduplicated)
  if (allIdentities.length > 0) {
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      // Prefer entries with displayName over those without
      if (!uniqueIdentities.has(id.platformId) ||
          (id.displayName && !uniqueIdentities.get(id.platformId)?.displayName)) {
        uniqueIdentities.set(id.platformId, id);
      }
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    console.log(`Identities upserted: ${uniqueIdentities.size}`);
  }

  db.close();

  console.log(`\nImported: ${totalImported}, Skipped: ${totalSkipped}`);
}

// Auth-only function
async function auth(): Promise<void> {
  let config = loadConfig();

  // Get credentials if needed
  if (!config?.credentials) {
    console.log("=== Monzo Setup ===\n");
    console.log("1. Go to https://developers.monzo.com/");
    console.log("2. Create OAuth client with redirect URI: http://localhost:8742/callback\n");

    process.stdout.write("Client ID: ");
    const clientId = await new Promise<string>((r) => {
      process.stdin.once("data", (d) => r(d.toString().trim()));
    });

    process.stdout.write("Client Secret: ");
    const clientSecret = await new Promise<string>((r) => {
      process.stdin.once("data", (d) => r(d.toString().trim()));
    });

    config = { credentials: { client_id: clientId, client_secret: clientSecret } };
    saveConfig(config);
    console.log();
  }

  const oauth = createMonzoOAuthClient(config);

  console.log("Authenticating with Monzo...");
  const tokens = await oauth.authorize();

  // Test auth by listing accounts
  const accounts = await waitForSCA(tokens.access_token);
  console.log(`Authenticated. Found ${accounts.length} account(s).`);
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const headless = args.includes("--headless");
  const command = args.find((a) => !a.startsWith("--"));

  if (command === "reset") {
    createTokenManager("monzo").clear();
    console.log("Tokens cleared from database.");

    // Also delete config file if it exists
    if (existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
      console.log("Config file cleared.");
    }
  } else if (command === "auth") {
    await auth();
  } else if (command === "status") {
    const config = loadConfig();

    if (!config) {
      console.log(`Not configured. Run: ${getMonzoAuthCommand()}`);
    } else {
      const oauth = createMonzoOAuthClient(config);
      const tokens = oauth.getTokens();
      console.log(`Credentials: ✓`);
      if (tokens) {
        const valid = Date.now() < tokens.expires_at;
        const mins = Math.round((tokens.expires_at - Date.now()) / 60000);
        console.log(`Token: ${valid ? `valid (${mins}m)` : "expired"}`);
      } else {
        console.log("Token: none");
      }
    }
  } else {
    await sync({ headless });
  }
}
