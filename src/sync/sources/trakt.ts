import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTokenManager, deriveOAuthAuthStatus, type OAuthTokens } from "../../lib/oauth-tokens";
import { syncTrakt } from "../../parsers/trakt-api";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

const CONFIG_PATH = join(homedir(), ".config", "timeline", "trakt.json");

interface TraktConfig {
  client_id: string;
  client_secret: string;
  tokens?: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
}

function loadConfig(): TraktConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export const traktSyncSource: SyncSource = {
  name: "trakt",
  description: "Sync Trakt watch history via API",
  enabled: true,
  configSchema: [
    {
      key: "account",
      type: "string",
      label: "Account",
      description: "Account name stored with imported watch history",
      required: true,
    },
  ],

  authStatus() {
    const config = loadConfig();
    const hasClientCredentials = Boolean(config?.client_id && config.client_secret);
    return deriveOAuthAuthStatus(hasClientCredentials, createTokenManager<OAuthTokens>("trakt").load());
  },

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    const config = loadConfig();

    if (!config) {
      return "Trakt not configured. Run: bun run src/parsers/trakt-api.ts";
    }

    if (!config.tokens) {
      return "Trakt not authenticated. Run: bun run src/parsers/trakt-api.ts";
    }

    // Note: We don't check expiry here because the parser auto-refreshes tokens
    // Just check that we have a refresh token
    if (!config.tokens.refresh_token) {
      return "Trakt missing refresh token. Run: bun run src/parsers/trakt-api.ts";
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["trakt"];

    if (!sourceConfig?.account) {
      return {
        source: "trakt",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'account' in sync config for trakt. Add account = \"name\" to [sync.trakt] in config.toml",
        durationMs: Date.now() - startTime,
      };
    }

    const accountName = sourceConfig.account;

    try {
      if (options.verbose) {
        console.log(`[trakt] Starting sync for account: ${accountName}`);
      }

      const stats = await syncTrakt(accountName, { headless: true });

      return {
        source: "trakt",
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "trakt",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
