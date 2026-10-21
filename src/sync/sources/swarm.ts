import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTokenManager, deriveOAuthAuthStatus, type OAuthTokens } from "../../lib/oauth-tokens";
import { SwarmSyncError, syncSwarm } from "../../parsers/swarm-api";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

const CONFIG_PATH = join(homedir(), ".config", "timeline", "swarm.json");

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

export const swarmSyncSource: SyncSource = {
  name: "swarm",
  description: "Sync Foursquare Swarm check-ins via API",
  enabled: true,

  authStatus() {
    return deriveOAuthAuthStatus(hasCredentials(), createTokenManager<OAuthTokens>("swarm").load());
  },

  async canSync(): Promise<string | null> {
    if (!hasCredentials()) {
      return "Swarm not configured. Create ~/.config/timeline/swarm.json, then run: bun run src/parsers/swarm-api.ts auth";
    }
    if (!createTokenManager<OAuthTokens>("swarm").load()) {
      return "Swarm not authenticated. Run: bun run src/parsers/swarm-api.ts auth";
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    try {
      const stats = await syncSwarm({ headless: true });
      return {
        source: "swarm",
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "swarm",
        success: false,
        eventsAdded: error instanceof SwarmSyncError ? error.stats.imported : 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
