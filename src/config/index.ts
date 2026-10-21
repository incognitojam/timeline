/**
 * Timeline Service Configuration
 *
 * Loads configuration from TOML files with environment variable overrides.
 * Priority: TIMELINE_CONFIG env > ~/.config/timeline/config.toml
 */

import { parse as parseTOML } from "@iarna/toml";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { deepMerge } from "./deep-merge";
import type {
  ServiceConfig,
  ServerConfig,
  DatabaseConfig,
  SchedulerConfig,
  SyncSourceConfig,
  InboxConfig,
  InboxSourceConfig,
  MediaConfig,
  BackupConfig,
  LlmConfig,
  EmbeddingsConfig,
} from "./types";

// Re-export types
export * from "./types";

const CONFIG_DIR = join(homedir(), ".config", "timeline");

const DEFAULT_DATA_DIR = join(homedir(), ".local", "share", "timeline");

const DEFAULT_CONFIG: ServiceConfig = {
  server: {
    host: "127.0.0.1",
    port: 3001,
  },
  database: {
    path: join(DEFAULT_DATA_DIR, "timeline.db"),
  },
  scheduler: {
    enabled: true,
    default_interval: "1h",
    stagger: true,
  },
  sync: {},
  inbox: {
    watch_enabled: true,
    base_path: join(homedir(), "timeline-inbox"),
    sources: {},
  },
  media: {
    path: join(DEFAULT_DATA_DIR, "media"),
  },
  backup: {},
  llm: { providers: {} },
};

let envFileLoaded = false;
let legacyEmbeddingWarningLogged = false;

export function resolveEnvFilePath(): string {
  return expandPath(process.env.TIMELINE_ENV_FILE ?? join(CONFIG_DIR, "env"));
}

// Config file priority: TIMELINE_CONFIG env > ~/.config/timeline/config.toml
function resolvePrimaryConfigPath(): string {
  if (process.env.TIMELINE_CONFIG !== undefined) {
    return expandPath(process.env.TIMELINE_CONFIG);
  }
  return resolveUserConfigPath();
}

function resolveUserConfigPath(): string {
  return join(CONFIG_DIR, "config.toml");
}

/**
 * Expand ~ to home directory in paths
 */
export function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function parseQuotedEnvValue(
  value: string,
  quote: '"' | "'",
  envPath: string,
  lineNumber: number,
): string {
  let parsed = "";
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (char === quote) {
      const rest = value.slice(index + 1).trim();
      if (rest && !rest.startsWith("#")) {
        throw new Error(
          `Invalid env file ${envPath}:${lineNumber}: unexpected characters after quoted value`,
        );
      }
      return parsed;
    }

    if (quote === '"' && char === "\\") {
      index++;
      if (index >= value.length) {
        parsed += "\\";
        break;
      }
      const escaped = value[index];
      switch (escaped) {
        case "n":
          parsed += "\n";
          break;
        case "r":
          parsed += "\r";
          break;
        case "t":
          parsed += "\t";
          break;
        default:
          parsed += escaped;
          break;
      }
      continue;
    }

    parsed += char;
  }

  throw new Error(`Invalid env file ${envPath}:${lineNumber}: unterminated quoted value`);
}

function parseEnvValue(rawValue: string, envPath: string, lineNumber: number): string {
  const value = rawValue.trimStart();
  if (value.startsWith('"')) {
    return parseQuotedEnvValue(value, '"', envPath, lineNumber);
  }
  if (value.startsWith("'")) {
    return parseQuotedEnvValue(value, "'", envPath, lineNumber);
  }

  const commentIndex = value.search(/\s#/);
  const withoutComment = commentIndex === -1 ? value : value.slice(0, commentIndex);
  return withoutComment.trimEnd();
}

/**
 * Load Timeline's env file into process.env, without overriding variables that
 * were already exported by the caller. This makes CLI entry points behave like
 * the launchd service wrapper: secrets can live in ~/.config/timeline/env
 * instead of every shell session sourcing them manually.
 */
export function loadEnvFile(): void {
  if (envFileLoaded) return;
  if (process.env.TIMELINE_ENV_FILE_LOADED === "1") {
    envFileLoaded = true;
    return;
  }

  const envPath = resolveEnvFilePath();
  if (!existsSync(envPath)) {
    envFileLoaded = true;
    return;
  }

  const content = readFileSync(envPath, "utf8");
  const assignments: Array<[string, string]> = [];
  for (const [lineIndex, rawLine] of content.split(/\r?\n/).entries()) {
    const lineNumber = lineIndex + 1;
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid env file ${envPath}:${lineNumber}: expected KEY=value`);
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    assignments.push([key, parseEnvValue(rawValue, envPath, lineNumber)]);
  }

  for (const [key, value] of assignments) {
    process.env[key] = value;
  }
  envFileLoaded = true;
}

/**
 * Apply environment variable overrides to config
 */
function applyEnvOverrides(config: ServiceConfig): ServiceConfig {
  const result = { ...config };

  // Server overrides
  if (process.env.TIMELINE_HOST) {
    result.server = { ...result.server, host: process.env.TIMELINE_HOST };
  }
  const portStr = process.env.TIMELINE_PORT || process.env.PORT;
  if (portStr) {
    const port = parseInt(portStr, 10);
    result.server = { ...result.server, port };
  }
  if (process.env.TIMELINE_PUBLIC_URL) {
    result.server = { ...result.server, public_url: process.env.TIMELINE_PUBLIC_URL };
  }

  // Database override
  if (process.env.TIMELINE_DB_PATH) {
    result.database = { ...result.database, path: process.env.TIMELINE_DB_PATH };
  }

  // Inbox path override
  if (process.env.TIMELINE_INBOX_PATH) {
    result.inbox = { ...result.inbox, base_path: process.env.TIMELINE_INBOX_PATH };
  }

  // Media path override
  if (process.env.TIMELINE_MEDIA_PATH) {
    result.media = { ...result.media, path: process.env.TIMELINE_MEDIA_PATH };
  }

  return result;
}

/** Environment variables that configured embeddings before `[embeddings]` existed. */
export const LEGACY_EMBEDDING_ENV_VARS = [
  "TIMELINE_EMBEDDING_ENDPOINT",
  "TIMELINE_EMBEDDING_MODEL",
  "TIMELINE_EMBEDDING_DIMENSIONS",
  "TIMELINE_EMBEDDING_PROFILE",
  "TIMELINE_EMBEDDING_PROVIDER",
  "TIMELINE_EMBEDDING_API_KEY_ENV",
] as const;

export function legacyEmbeddingEnvVarsSet(): string[] {
  return LEGACY_EMBEDDING_ENV_VARS.filter((key) => process.env[key] !== undefined);
}

function parseEmbeddingsConfig(raw: unknown): EmbeddingsConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("[embeddings] must be a table");
  }
  const table = raw as Record<string, unknown>;
  const known = new Set(["base_url", "model", "dimensions", "api_key_env", "profile", "document_prefix", "query_prefix", "timeout_seconds"]);
  for (const key of Object.keys(table)) {
    if (!known.has(key)) throw new Error(`[embeddings] has unknown key "${key}"`);
  }

  const requiredString = (key: string): string => {
    const value = table[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`[embeddings] ${key} must be a non-empty string`);
    return value;
  };
  const optionalString = (key: string): string | undefined => {
    const value = table[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`[embeddings] ${key} must be a string`);
    return value;
  };

  const baseUrl = requiredString("base_url");
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`[embeddings] base_url is not a valid URL: ${baseUrl}`);
  }
  const dimensions = table.dimensions;
  if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error("[embeddings] dimensions must be a positive integer");
  }
  const timeoutSeconds = table.timeout_seconds;
  if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    throw new Error("[embeddings] timeout_seconds must be a positive number");
  }

  return {
    base_url: baseUrl,
    model: requiredString("model"),
    dimensions,
    api_key_env: optionalString("api_key_env"),
    profile: optionalString("profile"),
    document_prefix: optionalString("document_prefix"),
    query_prefix: optionalString("query_prefix"),
    timeout_seconds: timeoutSeconds,
  };
}

/**
 * Parse TOML config file
 * Checks: TIMELINE_CONFIG env > ~/.config/timeline/config.toml
 */
async function loadTOMLConfig(): Promise<Partial<ServiceConfig> | null> {
  loadEnvFile();

  const hasExplicitConfig = process.env.TIMELINE_CONFIG !== undefined;
  const primaryConfigPath = resolvePrimaryConfigPath();
  const paths = [primaryConfigPath];

  for (const configPath of paths) {
    try {
      const file = Bun.file(configPath);
      if (!(await file.exists())) {
        if (hasExplicitConfig) {
          throw new Error(`TIMELINE_CONFIG does not exist: ${configPath}`);
        }
        continue;
      }

      const content = await file.text();
      const parsed = parseTOML(content) as Record<string, unknown>;

      // Transform the flat TOML structure into our nested config
      const config: Partial<ServiceConfig> = {};

      if (parsed.server) {
        config.server = parsed.server as ServerConfig;
      }

      if (parsed.database) {
        config.database = parsed.database as DatabaseConfig;
      }

      if (parsed.scheduler) {
        config.scheduler = parsed.scheduler as SchedulerConfig;
      }

      // Sync sources are under [sync.sourcename]
      if (parsed.sync) {
        config.sync = parsed.sync as Record<string, SyncSourceConfig>;
      }

      // Inbox config - base settings plus sources
      if (parsed.inbox) {
        const inboxRaw = parsed.inbox as Record<string, unknown>;
        config.inbox = {
          watch_enabled: inboxRaw.watch_enabled as boolean ?? true,
          base_path: inboxRaw.base_path as string ?? DEFAULT_CONFIG.inbox.base_path,
          archive_path: inboxRaw.archive_path as string | undefined,
          sources: (inboxRaw.sources as Record<string, InboxSourceConfig>) ?? {},
        };
      }

      // Media config
      if (parsed.media) {
        config.media = parsed.media as MediaConfig;
      }

      // Backup config (offsite R2 backend, under [backup.r2])
      if (parsed.backup) {
        config.backup = parsed.backup as BackupConfig;
      }

      // LLM providers (under [llm.providers.<name>]); no baked-in default, so
      // text generation is a no-op until at least one provider is configured.
      if (parsed.llm) {
        config.llm = parsed.llm as LlmConfig;
      }

      if (parsed.embeddings !== undefined) {
        config.embeddings = parseEmbeddingsConfig(parsed.embeddings);
      }

      return config;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load TOML config from ${configPath}: ${reason}`);
    }
  }

  return null;
}

/**
 * Load configuration with priority:
 * 1. Environment variables (highest priority)
 * 2. TOML config file (TIMELINE_CONFIG or ~/.config/timeline/config.toml)
 * 3. Defaults (lowest priority)
 */
export async function loadConfig(): Promise<ServiceConfig> {
  loadEnvFile();

  // Start with defaults, merge TOML config if found
  const tomlConfig = await loadTOMLConfig();
  let config = tomlConfig ? deepMerge(DEFAULT_CONFIG, tomlConfig) : { ...DEFAULT_CONFIG };

  // Apply environment variable overrides
  config = applyEnvOverrides(config);

  const legacyEmbeddingVars = legacyEmbeddingEnvVarsSet();
  if (legacyEmbeddingVars.length > 0 && !legacyEmbeddingWarningLogged) {
    legacyEmbeddingWarningLogged = true;
    console.warn(
      `[config] ${legacyEmbeddingVars.join(", ")} ${legacyEmbeddingVars.length === 1 ? "is" : "are"} no longer read; ` +
        "configure embeddings under [embeddings] in config.toml (see docs/user/embeddings.md)",
    );
  }

  // Expand paths
  config.database.path = expandPath(config.database.path);
  config.inbox.base_path = expandPath(config.inbox.base_path);
  if (config.inbox.archive_path) {
    config.inbox.archive_path = expandPath(config.inbox.archive_path);
  }
  config.media.path = expandPath(config.media.path);

  return config;
}

/**
 * Get the path to the config directory
 */
export function getConfigDir(): string {
  return CONFIG_DIR;
}

/**
 * Get the path to the TOML config file
 */
export function getConfigPath(): string {
  loadEnvFile();
  return resolvePrimaryConfigPath();
}

/**
 * Check if a TOML config file exists
 */
export async function hasConfig(): Promise<boolean> {
  loadEnvFile();
  const file = Bun.file(resolvePrimaryConfigPath());
  return await file.exists();
}

/**
 * Resolve an inbox source's local path to an absolute path
 */
export function resolveSourcePath(config: ServiceConfig, source: InboxSourceConfig): string {
  const localPath = expandPath(source.local);

  // If already absolute, use as-is
  if (localPath.startsWith("/")) {
    return localPath;
  }

  // Otherwise, relative to inbox base_path
  return join(config.inbox.base_path, localPath);
}
