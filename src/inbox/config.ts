/**
 * Inbox Configuration
 *
 * Wraps the unified config loader to provide inbox-specific config.
 */

import { join } from "path";
import { homedir } from "os";
import { loadConfig as loadServiceConfig, expandPath } from "../config";
import type { InboxSourceConfig, InboxConfig as ServiceInboxConfig } from "../config/types";

// Re-export types
export type { InboxSourceConfig } from "../config/types";

// Default inbox location (used if no config found)
const DEFAULT_INBOX_PATH = join(homedir(), "timeline-inbox");

export interface InboxConfig {
  /** Source configurations keyed by name */
  sources: Record<string, InboxSourceConfig>;
  /** Base inbox directory */
  inbox_path: string;
  /** Archive processed files to this directory (optional) */
  archive_path?: string;
}

/**
 * Resolve a source's local path to an absolute path
 */
export function resolveSourcePath(config: InboxConfig, source: InboxSourceConfig): string {
  const localPath = expandPath(source.local);

  // If already absolute, use as-is
  if (localPath.startsWith("/")) {
    return localPath;
  }

  // Otherwise, relative to inbox_path
  return join(config.inbox_path, localPath);
}

/**
 * Load inbox configuration from unified config (TOML)
 */
export async function loadConfig(): Promise<InboxConfig> {
  const serviceConfig = await loadServiceConfig();
  return {
    sources: serviceConfig.inbox.sources,
    inbox_path: serviceConfig.inbox.base_path,
    archive_path: serviceConfig.inbox.archive_path,
  };
}

/**
 * Get enabled sources from config
 */
export function getEnabledSources(config: InboxConfig): [string, InboxSourceConfig][] {
  return Object.entries(config.sources).filter(
    ([_, source]) => source.enabled !== false
  );
}

/**
 * Get archive path for a processed file
 */
export function getArchivePath(config: InboxConfig, sourceName: string, fileName: string): string | null {
  if (!config.archive_path) return null;
  return join(config.archive_path, sourceName, fileName);
}

export const CONFIG_FILE = "config.toml";
