/**
 * rclone Sync Integration
 *
 * Syncs files from cloud storage to local inbox folders using rclone.
 */

import type { InboxConfig, InboxSourceConfig } from "./config";
import { resolveSourcePath, getEnabledSources } from "./config";
import { spawn } from "child_process";
import { mkdir } from "fs/promises";
import { backgroundCommand } from "../lib/background-priority";

export interface SyncOptions {
  verbose?: boolean;
  dryRun?: boolean;
  only?: string[];
}

export interface SyncResult {
  source: string;
  success: boolean;
  error?: string;
  filesTransferred?: number;
  bytesTransferred?: number;
}

/**
 * Check if rclone is available
 */
export async function checkRclone(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("rclone", ["version"], { stdio: "pipe" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Run rclone sync for a single source
 */
export async function syncSource(
  config: InboxConfig,
  sourceName: string,
  sourceConfig: InboxSourceConfig,
  options: SyncOptions
): Promise<SyncResult> {
  const result: SyncResult = {
    source: sourceName,
    success: false,
  };

  if (sourceConfig.type !== "rclone" || !sourceConfig.remote) {
    result.success = true; // Not an rclone source, skip
    return result;
  }

  const localPath = resolveSourcePath(config, sourceConfig);

  // Ensure local directory exists
  await mkdir(localPath, { recursive: true });

  const args = ["sync", sourceConfig.remote, localPath, "--progress"];

  if (options.dryRun) {
    args.push("--dry-run");
  }

  if (options.verbose) {
    args.push("-v");
  }

  return new Promise((resolve) => {
    if (options.verbose) {
      console.log(`  Running: rclone ${args.join(" ")}`);
    }

    const [command, ...commandArgs] = backgroundCommand(["rclone", ...args]);
    const proc = spawn(command, commandArgs, {
      stdio: options.verbose ? "inherit" : "pipe",
    });

    let stderr = "";

    if (!options.verbose && proc.stderr) {
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
    }

    proc.on("error", (error) => {
      result.error = `Failed to run rclone: ${error.message}`;
      resolve(result);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        result.success = true;
      } else {
        result.error = stderr || `rclone exited with code ${code}`;
      }
      resolve(result);
    });
  });
}

/**
 * Sync all enabled rclone sources
 */
export async function syncAll(
  config: InboxConfig,
  options: SyncOptions
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const sources = getEnabledSources(config);

  // Filter to rclone sources
  const rcloneSources = sources.filter(
    ([_, src]) => src.type === "rclone" && src.remote
  );

  // Filter by --only if specified
  const only = options.only;
  const filtered = only
    ? rcloneSources.filter(([name]) => only.includes(name))
    : rcloneSources;

  if (filtered.length === 0) {
    if (options.verbose) {
      console.log("No rclone sources to sync");
    }
    return results;
  }

  // Check if rclone is available
  if (!(await checkRclone())) {
    console.error("Error: rclone is not installed or not in PATH");
    console.error("Install with: brew install rclone");
    return results;
  }

  for (const [name, sourceConfig] of filtered) {
    if (options.verbose) {
      console.log(`\nSyncing: ${name}`);
      console.log(`  Remote: ${sourceConfig.remote}`);
    }

    const result = await syncSource(config, name, sourceConfig, options);
    results.push(result);

    if (result.success) {
      if (options.dryRun) {
        console.log(`\x1b[32m✓\x1b[0m ${name}: sync dry-run complete`);
      } else {
        console.log(`\x1b[32m✓\x1b[0m ${name}: synced from ${sourceConfig.remote}`);
      }
    } else {
      console.error(`\x1b[31m✗\x1b[0m ${name}: ${result.error}`);
    }
  }

  return results;
}
