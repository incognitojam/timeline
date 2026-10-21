import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getAppStateDb,
  getSyncState,
  setSyncState,
} from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
import {
  type AmpThread,
  importAmp,
  importAmpThreads,
  type ImportStats,
} from "../../parsers/amp";
import type { SyncSource, SyncOptions, SyncResult } from "../types";

const DEFAULT_AMP_DIR = join(homedir(), ".local", "share", "amp", "threads");
const DEFAULT_AMP_SECRETS_PATH = join(
  homedir(),
  ".local",
  "share",
  "amp",
  "secrets.json"
);
const DEFAULT_AMP_URL = "https://ampcode.com/";
const DEFAULT_API_KEY_ENV = "AMP_API_KEY";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_AMP_MODE = "auto";
const DEFAULT_INCLUDE_ARCHIVED = true;
const DEFAULT_INCLUDE_EMPTY = true;
const DEFAULT_REFRESH_RAW_DATA = false;

interface AmpUserInfo {
  username?: string | null;
  email?: string | null;
}

interface AmpThreadSummary {
  id: string;
  v?: number;
  title?: string;
  created?: number;
  messageCount?: number;
  userLastInteractedAt?: number;
  archived?: boolean;
  pinned?: boolean;
}

interface AmpRpcSuccess<T> {
  ok: true;
  result: T;
}

interface AmpRpcFailure {
  ok: false;
  error?: {
    code?: string;
    message?: string;
  };
}

type AmpRpcResponse<T> = AmpRpcSuccess<T> | AmpRpcFailure;

interface ListThreadsResult {
  threads: AmpThreadSummary[];
}

interface GetThreadResult {
  thread: {
    id: string;
    title?: string;
    updatedAt?: number;
    data: AmpThread;
  };
}

interface AmpSyncState {
  threadFingerprints?: Record<string, string>;
  lastSyncedAt?: string;
}

function expandHome(path: string): string {
  return path.startsWith("~") ? path.replace("~", homedir()) : path;
}

function stringConfig(
  config: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = config?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function booleanConfig(
  config: Record<string, unknown> | undefined,
  key: string,
  fallback: boolean
): boolean {
  const value = config?.[key];
  return typeof value === "boolean" ? value : fallback;
}

function getAmpMode(config?: Record<string, unknown>): "auto" | "api" | "files" {
  const mode = stringConfig(config, "mode") ?? DEFAULT_AMP_MODE;
  if (mode === "auto" || mode === "api" || mode === "files") return mode;
  throw new Error(`Invalid Amp sync mode: ${mode}`);
}

function getAmpUrl(config?: Record<string, unknown>): string {
  return new URL(stringConfig(config, "url") ?? DEFAULT_AMP_URL).toString();
}

function getPageSize(config?: Record<string, unknown>): number {
  const value = config?.page_size;
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("sync.amp.page_size must be a positive integer");
  }
  return value;
}

function getApiKeyFromSecretsFile(
  secretsPath: string,
  ampUrl: string
): string | null {
  if (!existsSync(secretsPath)) return null;

  const parsed = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<
    string,
    unknown
  >;
  const urlWithSlash = new URL(ampUrl).toString();
  const urlWithoutSlash = urlWithSlash.replace(/\/$/, "");
  const candidates = [
    `apiKey@${urlWithSlash}`,
    `apiKey@${urlWithoutSlash}`,
  ];

  for (const key of candidates) {
    const value = parsed[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getAmpApiKey(config?: Record<string, unknown>): string | null {
  const directKey =
    stringConfig(config, "api_key") ?? stringConfig(config, "apiKey");
  if (directKey) return directKey;

  const envName = stringConfig(config, "api_key_env") ?? DEFAULT_API_KEY_ENV;
  const envKey = process.env[envName]?.trim();
  if (envKey) return envKey;

  const secretsPath = expandHome(
    stringConfig(config, "secrets_path") ?? DEFAULT_AMP_SECRETS_PATH
  );
  return getApiKeyFromSecretsFile(secretsPath, getAmpUrl(config));
}

function getSourceAccount(
  config: Record<string, unknown> | undefined,
  user: AmpUserInfo
): string {
  const configured = stringConfig(config, "account");
  if (configured) return configured;

  const email = user.email?.trim();
  const emailLocalPart = email?.split("@")[0]?.trim();
  if (emailLocalPart) return emailLocalPart;

  const username = user.username?.trim();
  if (username) return username;

  throw new Error("Amp account could not be derived; set sync.amp.account");
}

function fingerprintThreadSummary(summary: AmpThreadSummary): string {
  return JSON.stringify(summary);
}

function emptyImportStats(): ImportStats {
  return {
    threads: 0,
    messages: 0,
    refreshed: 0,
    skipped: 0,
    identitiesUpserted: 0,
  };
}

class AmpApiClient {
  constructor(
    private readonly ampUrl: string,
    private readonly apiKey: string
  ) {}

  async getUserInfo(signal?: AbortSignal): Promise<AmpUserInfo> {
    return this.call<AmpUserInfo>("getUserInfo", {}, signal);
  }

  async listThreads(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ListThreadsResult> {
    return this.call<ListThreadsResult>("listThreads", params, signal);
  }

  async getThread(
    threadId: string,
    signal?: AbortSignal
  ): Promise<GetThreadResult> {
    return this.call<GetThreadResult>("getThread", { thread: threadId }, signal);
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.ampUrl.replace(/\/$/, "")}/api/internal?${encodeURIComponent(method)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ method, params }),
      signal,
    });

    const body = await response.text();
    let payload: AmpRpcResponse<T> | null = null;
    try {
      payload = JSON.parse(body) as AmpRpcResponse<T>;
    } catch {
      // Keep the HTTP status as the actionable error below.
    }

    if (!response.ok) {
      const message = payload?.ok === false ? payload.error?.message : undefined;
      throw new Error(
        `Amp API ${method} failed: HTTP ${response.status}${message ? ` (${message})` : ""}`
      );
    }

    if (!payload) {
      throw new Error(`Amp API ${method} returned invalid JSON`);
    }

    if (!payload.ok) {
      const code = payload.error?.code ?? "unknown-error";
      const message = payload.error?.message;
      throw new Error(
        `Amp API ${method} failed: ${code}${message ? ` (${message})` : ""}`
      );
    }

    return payload.result;
  }
}

/**
 * Get the Amp base directory from config or default location.
 * Default local install: ~/.local/share/amp/threads.
 * Configured imports may point at a directory containing account subdirectories.
 */
function getAmpBaseDir(config?: Record<string, unknown>): string {
  return (config?.path as string | undefined) ?? DEFAULT_AMP_DIR;
}

/**
 * Check if a directory contains account subdirectories vs direct thread files.
 */
function hasAccountSubdirs(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    // Subdirectories that don't start with T- are treated as account names.
    return entries.some(
      (e) => e.isDirectory() && !e.name.startsWith("T-") && !e.name.startsWith(".")
    );
  } catch {
    return false;
  }
}

/**
 * Get account directories to process.
 * Returns array of { account, path } objects.
 */
async function getAccountDirs(
  baseDir: string
): Promise<Array<{ account: string; path: string }>> {
  if (hasAccountSubdirs(baseDir)) {
    const entries = readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ account: e.name, path: join(baseDir, e.name) }));
  } else {
    const account = await getLocalAccount();
    if (!account) return [];
    return [{ account, path: baseDir }];
  }
}

/**
 * Get account for local Amp installation (via API).
 * Returns null if not logged in or API call fails.
 */
async function getLocalAccount(): Promise<string | null> {
  const secretsPath = join(homedir(), ".local", "share", "amp", "secrets.json");
  if (!existsSync(secretsPath)) {
    return null;
  }

  try {
    const secrets = JSON.parse(
      await Bun.file(secretsPath).text()
    ) as Record<string, string>;
    const apiKey = secrets["apiKey@https://ampcode.com/"];
    if (!apiKey) return null;

    const resp = await fetch("https://ampcode.com/api/user", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;

    const user = (await resp.json()) as { email: string };
    return user.email.split("@")[0];
  } catch {
    return null;
  }
}

async function canSyncFiles(
  config?: Record<string, unknown>
): Promise<string | null> {
  const baseDir = getAmpBaseDir(config);

  if (!existsSync(baseDir)) {
    return `Amp directory not found at ${baseDir}`;
  }

  const accounts = await getAccountDirs(baseDir);
  if (accounts.length === 0) {
    return "No Amp accounts found to sync";
  }

  return null;
}

async function syncFiles(options: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  const sourceConfig = options.config.sources["amp"];
  const baseDir = getAmpBaseDir(sourceConfig);

  const accounts = await getAccountDirs(baseDir);
  if (accounts.length === 0) {
    return {
      source: "amp",
      success: false,
      eventsAdded: 0,
      eventsUpdated: 0,
      error: "No Amp accounts found",
      durationMs: Date.now() - startTime,
    };
  }

  let totalMessages = 0;
  let totalRefreshed = 0;

  try {
    const db = getDb();
    initDb(db);

    for (const { account, path } of accounts) {
      if (options.verbose) {
        console.log(`[amp] Importing from ${path}`);
        console.log(`[amp] Account: ${account}`);
      }

      const stats = await importAmp(db, path, account);
      totalMessages += stats.messages;
      totalRefreshed += stats.refreshed;
    }

    db.close();

    return {
      source: "amp",
      success: true,
      eventsAdded: totalMessages,
      eventsUpdated: totalRefreshed,
      durationMs: Date.now() - startTime,
      metadata: { mode: "files" },
    };
  } catch (error) {
    return {
      source: "amp",
      success: false,
      eventsAdded: 0,
      eventsUpdated: 0,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

async function syncApi(
  options: SyncOptions,
  apiKey: string
): Promise<SyncResult> {
  const startTime = Date.now();
  const sourceConfig = options.config.sources["amp"];

  try {
    const client = new AmpApiClient(getAmpUrl(sourceConfig), apiKey);
    const user = await client.getUserInfo(options.signal);
    const account = getSourceAccount(sourceConfig, user);
    const appDb = getAppStateDb();
    const state = getSyncState<AmpSyncState>(appDb, "amp") ?? {};
    const previousFingerprints = state.threadFingerprints ?? {};
    const nextFingerprints: Record<string, string> = {};
    const threadsToImport: AmpThread[] = [];
    const pageSize = getPageSize(sourceConfig);
    const includeArchived = booleanConfig(sourceConfig, "include_archived", DEFAULT_INCLUDE_ARCHIVED);
    const includeEmpty = booleanConfig(sourceConfig, "include_empty", DEFAULT_INCLUDE_EMPTY);
    const refreshRawData = booleanConfig(sourceConfig, "refresh_raw_data", DEFAULT_REFRESH_RAW_DATA);
    let listed = 0;
    let fetched = 0;
    let skippedUnchanged = 0;

    if (options.verbose) {
      console.log(`[amp] Syncing via API as ${account}`);
    }

    for (let offset = 0; ; offset += pageSize) {
      const page = await client.listThreads(
        {
          limit: pageSize,
          offset,
          includeArchived,
          includeEmpty,
        },
        options.signal
      );

      if (page.threads.length === 0) break;
      listed += page.threads.length;

      for (const summary of page.threads) {
        const fingerprint = fingerprintThreadSummary(summary);
        nextFingerprints[summary.id] = fingerprint;

        if (!refreshRawData && previousFingerprints[summary.id] === fingerprint) {
          skippedUnchanged++;
          continue;
        }

        const result = await client.getThread(summary.id, options.signal);
        const thread = result.thread.data;
        threadsToImport.push({
          ...thread,
          id: thread.id || result.thread.id || summary.id,
          title: thread.title ?? result.thread.title ?? summary.title,
          updatedAt: thread.updatedAt ?? result.thread.updatedAt,
        });
        fetched++;
      }

      if (page.threads.length < pageSize) break;
    }

    let stats = emptyImportStats();
    if (threadsToImport.length > 0) {
      const db = getDb();
      initDb(db);
      try {
        stats = await importAmpThreads(db, threadsToImport, account, {
          refreshRawData,
          updateExisting: true,
        });
      } finally {
        db.close();
      }
    }

    setSyncState(appDb, "amp", {
      ...state,
      threadFingerprints: nextFingerprints,
      lastSyncedAt: new Date().toISOString(),
    } satisfies AmpSyncState);

    return {
      source: "amp",
      success: true,
      eventsAdded: stats.messages,
      eventsUpdated: stats.refreshed,
      durationMs: Date.now() - startTime,
      metadata: {
        mode: "api",
        account,
        listed,
        fetched,
        skippedUnchanged,
        threadsImported: stats.threads,
      },
    };
  } catch (error) {
    return {
      source: "amp",
      success: false,
      eventsAdded: 0,
      eventsUpdated: 0,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startTime,
    };
  }
}

export const ampSyncSource: SyncSource = {
  name: "amp",
  description: "Import Amp threads via API or legacy local JSON files",
  enabled: true,
  configSchema: [
    {
      key: "mode",
      type: "select",
      label: "Import mode",
      description: "Choose automatic detection, the API, or local files",
      options: ["auto", "api", "files"],
      default: DEFAULT_AMP_MODE,
    },
    {
      key: "url",
      type: "string",
      label: "API URL",
      description: "Amp API base URL",
      default: DEFAULT_AMP_URL,
    },
    {
      key: "account",
      type: "string",
      label: "Account",
      description: "Account name to use when it cannot be derived from the Amp API user",
    },
    {
      key: "path",
      type: "string",
      format: "path",
      label: "Threads directory",
      description: "Directory containing Amp thread JSON files; used only in files mode",
      default: DEFAULT_AMP_DIR,
    },
    {
      key: "secrets_path",
      type: "string",
      format: "path",
      label: "Secrets file",
      description: "Amp CLI secrets file used when no API key is configured",
      default: DEFAULT_AMP_SECRETS_PATH,
    },
    {
      key: "page_size",
      type: "number",
      label: "Page size",
      description: "Threads requested per API page",
      integer: true,
      min: 1,
      default: DEFAULT_PAGE_SIZE,
    },
    {
      key: "include_archived",
      type: "boolean",
      label: "Include archived threads",
      description: "Include archived threads when importing via the API",
      default: DEFAULT_INCLUDE_ARCHIVED,
    },
    {
      key: "include_empty",
      type: "boolean",
      label: "Include empty threads",
      description: "Include threads with no messages when importing via the API",
      default: DEFAULT_INCLUDE_EMPTY,
    },
    {
      key: "refresh_raw_data",
      type: "boolean",
      label: "Refresh raw data",
      description: "Refresh preserved raw data for unchanged threads when importing via the API",
      default: DEFAULT_REFRESH_RAW_DATA,
    },
  ],

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const mode = getAmpMode(config);
    const apiKey = mode !== "files" ? getAmpApiKey(config) : null;

    if (apiKey) {
      try {
        const client = new AmpApiClient(getAmpUrl(config), apiKey);
        await client.getUserInfo();
        return null;
      } catch (error) {
        return `Amp API unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (mode === "api") {
      return `Amp API key not configured. Set ${DEFAULT_API_KEY_ENV}, sync.amp.api_key, or sync.amp.secrets_path`;
    }

    return canSyncFiles(config);
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const sourceConfig = options.config.sources["amp"];
    const mode = getAmpMode(sourceConfig);
    const apiKey = mode !== "files" ? getAmpApiKey(sourceConfig) : null;

    if (apiKey) {
      return syncApi(options, apiKey);
    }

    if (mode === "api") {
      return {
        source: "amp",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: `Amp API key not configured. Set ${DEFAULT_API_KEY_ENV}, sync.amp.api_key, or sync.amp.secrets_path`,
        durationMs: 0,
      };
    }

    return syncFiles(options);
  },
};
