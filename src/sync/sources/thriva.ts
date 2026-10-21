import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sync as syncThriva } from "../../parsers/thriva";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

const CONFIG_PATH = join(homedir(), ".config", "timeline", "thriva.json");

interface ThrivaCredentials {
  email: string;
  password: string;
}

function loadCredentials(): ThrivaCredentials | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Derive account name from email (before the @)
 * e.g., "alice@example.com" -> "alice"
 */
function getAccountFromEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email;
  return email.substring(0, atIndex);
}

export const thrivaSyncSource: SyncSource = {
  name: "thriva",
  description: "Sync Thriva blood test biomarker results",
  enabled: true,

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    const creds = loadCredentials();

    if (!creds) {
      return `Thriva not configured. Create ${CONFIG_PATH} with: { "email": "...", "password": "..." }`;
    }

    if (!creds.email || !creds.password) {
      return "Thriva credentials incomplete. Need both email and password.";
    }

    // We can always sync if we have credentials - the parser will re-auth if needed
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();

    // Get account name from credentials email (no manual config needed)
    const creds = loadCredentials();
    if (!creds) {
      return {
        source: "thriva",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Credentials not found",
        durationMs: Date.now() - startTime,
      };
    }

    const accountName = getAccountFromEmail(creds.email);

    try {
      if (options.verbose) {
        console.log(`[thriva] Starting sync for account: ${accountName}`);
      }

      const stats = await syncThriva(accountName);

      return {
        source: "thriva",
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "thriva",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
