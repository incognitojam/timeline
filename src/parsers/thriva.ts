/**
 * Thriva Blood Test Parser
 *
 * Imports biomarker results from Thriva blood tests into the timeline.
 * Uses password-based authentication to get a JWT token.
 *
 * Usage:
 *   bun run src/parsers/thriva.ts [account-name]    # Sync biomarker results
 *   bun run src/parsers/thriva.ts status            # Check auth status
 *   bun run src/parsers/thriva.ts reset             # Clear stored tokens
 *
 * Setup:
 *   Create ~/.config/timeline/thriva.json with:
 *   { "email": "alice@example.com", "password": "your-password" }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";
import { deleteSyncState, getAppStateDb } from "../db/app-state";
import { createTokenManager, type OAuthTokens } from "../lib/oauth-tokens";
import { getBiomarkerInfo } from "./thriva-biomarkers";

// API Types
interface ThrivaBiomarkerResult {
  id: string;
  type: "biomarker_result";
  attributes: {
    type: "numeric" | "text";
    value: number | string;
    unit: string;
    operator: string | null;
    level: "optimal" | "normal" | "abnormal" | "highly_abnormal";
    notes: string;
    reference_ranges: Array<{
      name: string;
      level: string;
      lower_bound: number | null;
      upper_bound: number | null;
      description: string;
    }>;
    sample_collected_at: string;
    sample_processed_at: string;
    timestamp: string;
    status: "successful" | "failed" | "pending";
    source: string;
    failure_reason: string | null;
  };
  relationships: {
    biomarker: {
      data: {
        type: "biomarker";
        id: string;
      };
    };
  };
}

interface ThrivaBiomarkerResponse {
  data: ThrivaBiomarkerResult[];
  meta: {
    pagination: {
      limit: number;
      offset: number;
      total_count: number;
    };
  };
}

// Order types
interface ThrivaOrderResult {
  id: string;
  type: "shop_order";
  attributes: {
    order_state: string;
    completed_at: string | null;
    created_at: string;
    total_cents: number;
    sub_total_cents: number;
    credit_applied_cents: number;
    discount_amount_cents: number;
  };
  relationships: {
    test_cycles: {
      data: Array<{ type: string; id: string }>;
    };
    line_items: {
      data: Array<{ type: string; id: string }>;
    };
  };
}

interface ThrivaOrderResponse {
  data: ThrivaOrderResult[];
  included?: Array<{
    id: string;
    type: string;
    attributes: Record<string, unknown>;
  }>;
}

// Token stored in app-state.db
interface ThrivaTokens extends OAuthTokens {
  // Just access_token and expires_at from base
}

// Credentials stored in config file
interface ThrivaCredentials {
  email: string;
  password: string;
}

// Config
const CONFIG_DIR = join(homedir(), ".config", "timeline");
const CONFIG_PATH = join(CONFIG_DIR, "thriva.json");
const THRIVA_API_URL = "https://api.thriva.co";

function loadCredentials(): ThrivaCredentials | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

// Token manager for storing JWT in app-state.db
const tokenManager = createTokenManager<ThrivaTokens>("thriva");

// API helper - sends JWT as cookie
async function thrivaGet<T>(jwt: string, endpoint: string): Promise<T> {
  const response = await fetch(`${THRIVA_API_URL}${endpoint}`, {
    headers: {
      Cookie: `jwt=${jwt}`,
      Accept: "application/vnd.api+json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Thriva API error ${response.status}: ${error}`);
  }

  return response.json();
}

// Authenticate with email/password, get JWT from Set-Cookie
async function authenticate(creds: ThrivaCredentials): Promise<ThrivaTokens> {
  console.log("Authenticating with Thriva...");

  const response = await fetch(`${THRIVA_API_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      type: "user",
      username: creds.email,
      password: creds.password,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Auth failed (${response.status}): ${error}`);
  }

  // Extract JWT from Set-Cookie header
  const setCookie = response.headers.get("set-cookie") || "";
  const jwtMatch = setCookie.match(/jwt=([^;]+)/);
  if (!jwtMatch) {
    throw new Error("No JWT in response cookies");
  }

  const jwt = jwtMatch[1];

  // Parse JWT to get expiration (base64 decode middle segment)
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
  const expiresAt =
    typeof payload.exp === "string"
      ? parseInt(payload.exp, 10) * 1000
      : payload.exp * 1000;

  const tokens: ThrivaTokens = {
    access_token: jwt,
    expires_at: expiresAt,
  };

  tokenManager.save(tokens);
  console.log("✓ Authenticated\n");

  return tokens;
}

// Ensure we have valid tokens, re-auth if expired
async function ensureValidTokens(creds: ThrivaCredentials): Promise<ThrivaTokens> {
  let tokens = tokenManager.load();

  if (!tokens || tokenManager.isExpired(tokens, 300)) {
    tokens = await authenticate(creds);
  }

  return tokens;
}

// Fetch all biomarker results with pagination
async function fetchBiomarkerResults(jwt: string): Promise<ThrivaBiomarkerResult[]> {
  const results: ThrivaBiomarkerResult[] = [];
  let offset = 0;
  const limit = 100;

  console.log("Fetching biomarker results...");

  while (true) {
    const response = await thrivaGet<ThrivaBiomarkerResponse>(
      jwt,
      `/v2/biomarker_results?sort=-timestamp&offset=${offset}&limit=${limit}&filter[status]=successful`
    );

    results.push(...response.data);

    if (response.data.length < limit) {
      break;
    }
    offset += limit;
    process.stdout.write(`  ${results.length}/${response.meta.pagination.total_count}...\r`);
  }

  console.log(`✓ Fetched ${results.length} biomarker results\n`);
  return results;
}

// Fetch all orders with pagination
async function fetchOrders(jwt: string): Promise<ThrivaOrderResult[]> {
  const results: ThrivaOrderResult[] = [];
  let offset = 0;
  const limit = 50;

  console.log("Fetching orders...");

  while (true) {
    const response = await thrivaGet<ThrivaOrderResponse>(
      jwt,
      `/v1/shop/orders?filter[state]=completed&sort=-completed_at&offset=${offset}&limit=${limit}`
    );

    results.push(...response.data);

    if (response.data.length < limit) {
      break;
    }
    offset += limit;
  }

  console.log(`✓ Fetched ${results.length} orders\n`);
  return results;
}

// Format level as indicator
function getLevelIndicator(level: string): string {
  switch (level) {
    case "optimal":
      return "++";
    case "normal":
      return "";
    case "abnormal":
      return "!";
    case "highly_abnormal":
      return "!!";
    default:
      return "";
  }
}

// Sync stats for orchestrator
export interface ThrivaSyncStats {
  imported: number;
  skipped: number;
}

/**
 * Derive account name from email (before the @)
 */
function getAccountFromEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email;
  return email.substring(0, atIndex);
}

// Main sync function
export async function sync(sourceAccount?: string): Promise<ThrivaSyncStats> {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      `No credentials found. Create ${CONFIG_PATH} with: { "email": "...", "password": "..." }`
    );
  }

  // If no account provided, derive from email
  const account = sourceAccount || getAccountFromEmail(creds.email);

  const tokens = await ensureValidTokens(creds);
  const results = await fetchBiomarkerResults(tokens.access_token);

  // Insert into database
  const db = getDb();
  initDb(db);

  // Count existing events before import
  const countBefore = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM events WHERE source = 'thriva'"
  ).get()?.count || 0;

  const importBatch = `thriva-${Date.now()}`;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: ThrivaBiomarkerResult[]) => {
    for (const result of items) {
      const biomarkerId = result.relationships.biomarker.data.id;
      const biomarker = getBiomarkerInfo(biomarkerId);
      const attrs = result.attributes;

      const levelIndicator = getLevelIndicator(attrs.level);
      const valueStr =
        attrs.operator != null
          ? `${attrs.operator}${attrs.value}`
          : String(attrs.value);

      // Title: "Vitamin D: 80 nmol/L ++" or "Vitamin D: 80 nmol/L ++ (external)"
      const sourceLabel = attrs.source !== "thriva" ? ` (${attrs.source})` : "";
      const title = `${biomarker.name}: ${valueStr} ${attrs.unit}${levelIndicator ? ` ${levelIndicator}` : ""}${sourceLabel}`.trim();

      // Content: fuller description for search
      const content = `${biomarker.name} (${biomarkerId}): ${valueStr} ${attrs.unit} - ${attrs.level}`;

      // Tags: biomarker ID, category, level, source (thriva vs external)
      const tags = [biomarkerId, biomarker.category, attrs.level, attrs.source];

      insert.run(
        "thriva",
        result.id,
        account,
        "thriva:biomarker",
        attrs.sample_collected_at,
        title,
        content,
        JSON.stringify(tags),
        JSON.stringify(result),
        importBatch
      );
    }
  });

  insertMany(results);

  // Also fetch and insert orders
  const orders = await fetchOrders(tokens.access_token);

  const insertOrder = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertOrders = db.transaction((items: ThrivaOrderResult[]) => {
    for (const order of items) {
      const attrs = order.attributes;
      const timestamp = attrs.completed_at || attrs.created_at;
      const total = (attrs.total_cents / 100).toFixed(2);

      // Title: "Blood Test Order - £49.00"
      const title = `Blood Test Order - £${total}`;

      // Content: more details
      const contentParts = [`Order ${order.id}: £${total}`];
      if (attrs.credit_applied_cents > 0) {
        contentParts.push(`(£${(attrs.credit_applied_cents / 100).toFixed(2)} credit applied)`);
      }
      if (attrs.discount_amount_cents > 0) {
        contentParts.push(`(£${(attrs.discount_amount_cents / 100).toFixed(2)} discount)`);
      }
      const content = contentParts.join(" ");

      // Tags: order state
      const tags = [attrs.order_state];

      insertOrder.run(
        "thriva",
        order.id,
        account,
        "thriva:order",
        timestamp,
        title,
        content,
        JSON.stringify(tags),
        JSON.stringify(order),
        importBatch
      );
    }
  });

  insertOrders(orders);

  // Count after to determine how many were actually inserted
  const countAfter = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM events WHERE source = 'thriva'"
  ).get()?.count || 0;

  const totalFetched = results.length + orders.length;
  const imported = countAfter - countBefore;
  const skipped = totalFetched - imported;

  db.close();

  console.log(`Imported: ${imported} (${results.length} biomarkers, ${orders.length} orders), Skipped: ${skipped}`);

  return { imported, skipped };
}

// Show status
function showStatus(): void {
  const creds = loadCredentials();
  const tokens = tokenManager.load();

  console.log("=== Thriva Status ===\n");

  if (!creds) {
    console.log(`Credentials: ✗ (create ${CONFIG_PATH})`);
  } else {
    console.log(`Credentials: ✓ (${creds.email})`);
  }

  if (!tokens) {
    console.log("Token: none");
  } else {
    const expired = tokenManager.isExpired(tokens);
    const hoursLeft = Math.round((tokens.expires_at - Date.now()) / 3600000);
    console.log(`Token: ${expired ? "expired" : `valid (${hoursLeft}h left)`}`);
  }
}

// Clear tokens
function reset(): void {
  const appDb = getAppStateDb();
  deleteSyncState(appDb, "thriva");
  console.log("Token cleared from database.");
}

// Auth-only function
async function auth(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(
      `No credentials found. Create ${CONFIG_PATH} with: { "email": "...", "password": "..." }`
    );
  }

  const tokens = await ensureValidTokens(creds);

  // Test auth by fetching biomarker results (just check we can make an authenticated request)
  const response = await thrivaGet<ThrivaBiomarkerResponse>(
    tokens.access_token,
    `/v2/biomarker_results?limit=1`
  );

  console.log(`Authenticated as: ${creds.email}`);
  console.log(`Total biomarker results: ${response.meta.pagination.total_count}`);
}

// CLI - only run when executed directly
if (import.meta.main) {
  const command = process.argv[2];

  if (command === "status") {
    showStatus();
  } else if (command === "auth") {
    await auth();
  } else if (command === "reset") {
    reset();
  } else {
    // Default: sync (use email-derived account name by default)
    const account = command || undefined;
    await sync(account);
  }
}
