#!/usr/bin/env bun
/**
 * Inbox Processor CLI
 *
 * Processes files dropped into inbox folders, routing them to appropriate parsers.
 * Can optionally sync files from cloud storage first using rclone.
 *
 * Usage:
 *   bun run src/inbox/index.ts                  # Process new files
 *   bun run src/inbox/index.ts --sync           # Sync from cloud first
 *   bun run src/inbox/index.ts --only sms       # Process specific source
 *   bun run src/inbox/index.ts --dry-run        # Show what would happen
 *   bun run src/inbox/index.ts --status         # Show inbox status
 */

import { parseArgs } from "util";
import { loadConfig, CONFIG_FILE } from "./config";
import { syncAll } from "./sync";
import { processAll, showStatus } from "./process";
import { getTimelineDbPath } from "../db/paths";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      sync: {
        type: "boolean",
        short: "s",
        description: "Sync from cloud storage before processing",
      },
      only: {
        type: "string",
        short: "o",
        description: "Process only specific source(s) (comma-separated)",
      },
      "dry-run": {
        type: "boolean",
        short: "n",
        description: "Show what would be processed without making changes",
      },
      verbose: {
        type: "boolean",
        short: "v",
        description: "Show detailed output",
      },
      status: {
        type: "boolean",
        description: "Show inbox status and history",
      },
      help: {
        type: "boolean",
        short: "h",
        description: "Show help",
      },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`Inbox Processor - Process files from inbox folders

Usage:
  bun run src/inbox/index.ts [options]

Options:
  -s, --sync          Sync from cloud storage (rclone) before processing
  -o, --only <src>    Process only specific sources (comma-separated)
  -n, --dry-run       Show what would be processed without changes
  -v, --verbose       Show detailed output
      --status        Show inbox status and history
  -h, --help          Show this help

Examples:
  bun run inbox                     # Process new files in all sources
  bun run inbox --sync              # Sync from cloud, then process
  bun run inbox --only sms          # Process only SMS source
  bun run inbox --sync --only sms   # Sync and process SMS only
  bun run inbox --status            # Show processing history

Configuration:
  ${CONFIG_FILE}

Processed files tracked in app-state.db (alongside timeline.db)
`);
    return;
  }

  // Load configuration
  const config = await loadConfig();

  // Show status if requested
  if (values.status) {
    await showStatus(config);
    return;
  }

  const onlyList = values.only?.split(",").map((s) => s.trim().toLowerCase());

  const options = {
    dryRun: values["dry-run"] ?? false,
    verbose: values.verbose ?? false,
    only: onlyList,
  };

  if (options.dryRun) {
    console.log("DRY RUN - No changes will be made\n");
  }

  // Show database path
  const dbPath = getTimelineDbPath();
  console.log(`Database: ${dbPath}`);

  // Sync from cloud if requested
  if (values.sync) {
    console.log("\nSyncing from cloud storage...");
    const syncResults = await syncAll(config, options);

    const failed = syncResults.filter((r) => !r.success);
    if (failed.length > 0) {
      console.error(`\n${failed.length} sync(s) failed`);
      // Continue to process anyway - partial sync is still useful
    }
    console.log();
  }

  // Process files
  console.log("Processing inbox files...\n");
  const results = await processAll(config, options);

  // Summary
  const totalFiles = results.reduce((sum, r) => sum + r.filesProcessed, 0);
  const totalEvents = results.reduce((sum, r) => sum + r.eventsAdded, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

  console.log("\n" + "─".repeat(50));
  console.log(`Summary: ${totalFiles} file(s) processed, +${totalEvents} events`);

  if (totalErrors > 0) {
    console.log(`Errors: ${totalErrors}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
