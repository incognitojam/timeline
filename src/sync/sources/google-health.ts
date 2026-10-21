import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAppStateDb, getSyncState } from "../../db/app-state";
import { deriveOAuthAuthStatus } from "../../lib/oauth-tokens";
import { syncGoogleHealth } from "../../parsers/google-health-api";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

const CONFIG_PATH = join(homedir(), ".config", "timeline", "google-health.json");

interface GoogleHealthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

function loadTokens(): GoogleHealthTokens | null {
  return getSyncState<GoogleHealthTokens>(getAppStateDb(), "google-health");
}

function hasCredentials(): boolean {
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    const config: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return typeof config === "object" && config !== null &&
      "client_id" in config && typeof config.client_id === "string" && Boolean(config.client_id) &&
      "client_secret" in config && typeof config.client_secret === "string" && Boolean(config.client_secret);
  } catch {
    return false;
  }
}

export const googleHealthSyncSource: SyncSource = {
  name: "google-health",
  description: "Sync Google Health sleep, daily metrics, activity and weight",
  enabled: true,

  authStatus() {
    return deriveOAuthAuthStatus(hasCredentials(), loadTokens());
  },

  async canSync(): Promise<string | null> {
    if (!existsSync(CONFIG_PATH)) {
      return `Google Health not configured. Create ${CONFIG_PATH} with client_id and client_secret`;
    }
    const tokens = loadTokens();
    if (!tokens) {
      return "Google Health not authenticated. Run: bun run src/parsers/google-health-api.ts auth";
    }
    if (!tokens.refresh_token) {
      return "Google Health missing refresh token. Re-run: bun run src/parsers/google-health-api.ts auth";
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    try {
      const stats = await syncGoogleHealth({ verbose: options.verbose, headless: true });
      return {
        source: "google-health",
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "google-health",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
