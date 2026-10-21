import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { syncGitHub } from "../../parsers/github-api";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

const CONFIG_PATH = join(homedir(), ".config", "timeline", "github.json");

interface GitHubConfig {
  token: string;
  username: string;
  token_expires?: string;
}

function loadConfig(): GitHubConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export const githubSyncSource: SyncSource = {
  name: "github",
  description: "Sync GitHub activity via API",
  enabled: true,

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    const config = loadConfig();

    if (!config) {
      return "GitHub not configured. Create ~/.config/timeline/github.json with token and username";
    }

    if (!config.token) {
      return "Missing token in github.json";
    }

    if (!config.username) {
      return "Missing username in github.json";
    }

    // Check if token is expired
    if (config.token_expires) {
      const expires = new Date(config.token_expires);
      if (expires < new Date()) {
        return `GitHub token expired on ${config.token_expires}. Create a new PAT.`;
      }
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const config = loadConfig();

    if (!config?.username) {
      return {
        source: "github",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'username' in ~/.config/timeline/github.json",
        durationMs: Date.now() - startTime,
      };
    }

    const accountName = config.username;

    try {
      if (options.verbose) {
        console.log(`[github] Starting sync for account: ${accountName}`);
      }

      const stats = await syncGitHub(accountName);

      return {
        source: "github",
        success: true,
        eventsAdded: stats.events + stats.stars + stats.gists,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "github",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
