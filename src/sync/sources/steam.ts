import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { syncSteam } from "../../parsers/steam-api";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

const CONFIG_PATH = join(homedir(), ".config", "timeline", "steam.json");

interface SteamConfig {
  api_key: string;
  steam_id: string;
}

function loadConfig(): SteamConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (!config.api_key || !config.steam_id) return null;
    return config as SteamConfig;
  } catch {
    return null;
  }
}

export const steamSyncSource: SyncSource = {
  name: "steam",
  description: "Sync Steam gaming activity via API",
  enabled: true,

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    const config = loadConfig();

    if (!config) {
      return "Steam not configured. Run: bun run src/parsers/steam-api.ts auth";
    }

    if (!config.api_key) {
      return "Steam missing API key. Run: bun run src/parsers/steam-api.ts auth";
    }

    if (!config.steam_id) {
      return "Steam missing Steam ID. Run: bun run src/parsers/steam-api.ts auth";
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();

    try {
      if (options.verbose) {
        console.log("[steam] Starting sync");
      }

      const stats = await syncSteam({ headless: true });

      return {
        source: "steam",
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: stats.updated,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "steam",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
