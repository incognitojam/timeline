/**
 * Inbox Rclone Sync Source
 *
 * Pulls files from rclone-configured inbox sources (e.g. Google Drive, Dropbox)
 * into their local inbox directories, where the inbox watcher then picks them
 * up and runs the configured parser.
 *
 * Enable by adding a [sync.inbox-rclone] block to config.toml and defining one
 * or more [inbox.sources.<name>] entries with type = "rclone".
 */

import type { InboxSourceConfig } from "../../config";
import { type InboxConfig, loadConfig as loadInboxConfig } from "../../inbox/config";
import { checkRclone, syncAll } from "../../inbox/sync";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

function getRcloneInboxSources(
  inbox: InboxConfig
): Array<[string, InboxSourceConfig]> {
  return Object.entries(inbox.sources).filter(
    ([, src]) => src.type === "rclone" && src.remote && src.enabled !== false
  );
}

export const inboxRcloneSyncSource: SyncSource = {
  name: "inbox-rclone",
  description:
    "Pull files from rclone-configured inbox sources into local inbox dirs (watcher processes them)",
  enabled: true,

  async canSync(): Promise<string | null> {
    const inbox = await loadInboxConfig();
    const sources = getRcloneInboxSources(inbox);
    if (sources.length === 0) {
      return 'No rclone inbox sources configured. Add [inbox.sources.<name>] with type = "rclone".';
    }
    if (!(await checkRclone())) {
      return "rclone is not installed or not on PATH.";
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();

    const inbox = await loadInboxConfig();
    const results = await syncAll(inbox, { verbose: options.verbose });

    const failed = results.filter((r) => !r.success);
    const succeeded = results.filter((r) => r.success);

    return {
      source: "inbox-rclone",
      success: failed.length === 0,
      eventsAdded: 0,
      eventsUpdated: 0,
      error: failed.length
        ? failed
            .map((r) => `${r.source}: ${r.error ?? "unknown error"}`)
            .join("; ")
        : undefined,
      durationMs: Date.now() - startTime,
      metadata: {
        remotesSynced: succeeded.map((r) => r.source),
        remotesFailed: failed.map((r) => r.source),
      },
    };
  },
};
