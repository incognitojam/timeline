import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { syncWakaTime } from "../../parsers/wakatime-api";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

const CONFIG_PATH = join(homedir(), ".wakatime.cfg");

interface WakaTimeConfig {
  api_url?: string;
  api_key?: string;
}

function loadConfig(): WakaTimeConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;

  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    const config: WakaTimeConfig = {};

    for (const line of content.split("\n")) {
      const match = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        if (key === "api_url") config.api_url = value.trim();
        if (key === "api_key") config.api_key = value.trim();
      }
    }

    return config;
  } catch {
    return null;
  }
}

export const wakatimeSyncSource: SyncSource = {
  name: "wakatime",
  description: "Sync coding activity from WakaTime/Wakapi API",
  enabled: true,
  configSchema: [
    {
      key: "account",
      type: "string",
      label: "Account",
      description: "Account name stored with imported coding activity",
      required: true,
    },
  ],

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    const config = loadConfig();

    if (!config) {
      return "WakaTime not configured. Create ~/.wakatime.cfg with api_url and api_key";
    }

    if (!config.api_url) {
      return "Missing api_url in ~/.wakatime.cfg";
    }

    if (!config.api_key) {
      return "Missing api_key in ~/.wakatime.cfg";
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["wakatime"];

    if (!sourceConfig?.account) {
      return {
        source: "wakatime",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Missing 'account' in sync config for wakatime. Add account = \"name\" to [sync.wakatime] in config.toml",
        durationMs: Date.now() - startTime,
      };
    }

    const accountName = sourceConfig.account;

    try {
      if (options.verbose) {
        console.log(`[wakatime] Starting sync for account: ${accountName}`);
      }

      const stats = await syncWakaTime(accountName, 14);

      return {
        source: "wakatime",
        success: true,
        eventsAdded: stats.sessions,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "wakatime",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
