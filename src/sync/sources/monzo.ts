import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAppStateDb, getSyncState } from "../../db/app-state";
import { deriveOAuthAuthStatus } from "../../lib/oauth-tokens";
import { getMonzoAuthCommand, getMonzoParserPath } from "../../runtime-paths";
import type { SyncSource, SyncOptions, SyncResult } from "../types";
import { backgroundCommand } from "../../lib/background-priority";

const CONFIG_PATH = join(homedir(), ".config", "timeline", "monzo.json");

interface MonzoConfig {
  credentials: { client_id: string; client_secret: string };
}

interface MonzoTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
}

function loadConfig(): MonzoConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function loadTokens(): MonzoTokens | null {
  const appDb = getAppStateDb();
  return getSyncState<MonzoTokens>(appDb, "monzo");
}

export const monzoSyncSource: SyncSource = {
  name: "monzo",
  description: "Sync Monzo transactions via API",
  enabled: true,

  authStatus() {
    const config = loadConfig();
    const hasClientCredentials = Boolean(
      config?.credentials?.client_id && config.credentials.client_secret
    );
    return deriveOAuthAuthStatus(hasClientCredentials, loadTokens());
  },

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    const config = loadConfig();
    const authCommand = getMonzoAuthCommand();

    if (!config?.credentials) {
      return `Monzo not configured. Run: ${authCommand}`;
    }

    const tokens = loadTokens();
    if (!tokens) {
      return `Monzo not authenticated. Run: ${authCommand}`;
    }

    // Check if token is expired (with no refresh token to renew it)
    if (Date.now() >= tokens.expires_at && !tokens.refresh_token) {
      return `Monzo token expired. Run: ${authCommand}`;
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const TIMEOUT_MS = 10 * 60 * 1000;

    try {
      if (options.verbose) {
        console.log("[monzo] Starting sync via subprocess...");
      }

      // Run monzo parser as subprocess. --headless makes it fail fast instead
      // of opening an interactive OAuth browser flow when re-auth is required.
      const proc = Bun.spawn(
        backgroundCommand([process.execPath, getMonzoParserPath(), "--headless"]),
        {
          env: {
            ...process.env,
            // Pass through TIMELINE_DB_PATH if set
            TIMELINE_DB_PATH: process.env.TIMELINE_DB_PATH || "",
          },
          stdout: options.verbose ? "inherit" : "pipe",
          stderr: options.verbose ? "inherit" : "pipe",
        }
      );

      // Read stdout/stderr concurrently with the exit wait so the subprocess
      // can't deadlock filling its pipe buffer.
      const stdoutPromise: Promise<string> =
        !options.verbose && proc.stdout
          ? new Response(proc.stdout).text()
          : Promise.resolve("");
      const stderrPromise: Promise<string> =
        !options.verbose && proc.stderr
          ? new Response(proc.stderr).text()
          : Promise.resolve("");

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve("timeout");
        }, TIMEOUT_MS);
      });

      const exitResult = await Promise.race([proc.exited, timeout]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (timedOut) {
        proc.kill();
        return {
          source: "monzo",
          success: false,
          eventsAdded: 0,
          eventsUpdated: 0,
          error: `Subprocess timed out after ${TIMEOUT_MS / 1000}s`,
          durationMs: Date.now() - startTime,
        };
      }

      const exitCode = exitResult as number;

      if (exitCode !== 0) {
        const stderr = await stderrPromise;
        const stdout = await stdoutPromise;
        const errOutput = stderr.trim() || stdout.trim();
        const errorMsg = errOutput
          ? errOutput.split("\n").pop() || `Process exited with code ${exitCode}`
          : `Process exited with code ${exitCode}`;
        return {
          source: "monzo",
          success: false,
          eventsAdded: 0,
          eventsUpdated: 0,
          error: errorMsg,
          durationMs: Date.now() - startTime,
        };
      }

      // Parse stdout for stats if not verbose (verbose inherits output)
      let eventsAdded = 0;
      const stdout = await stdoutPromise;
      const match = stdout.match(/Imported:\s*(\d+)/);
      if (match) {
        eventsAdded = parseInt(match[1], 10);
      }

      return {
        source: "monzo",
        success: true,
        eventsAdded,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "monzo",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
