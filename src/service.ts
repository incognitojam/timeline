#!/usr/bin/env bun
/**
 * Timeline Service - Unified Entry Point
 *
 * This bootstrap deliberately imports database-using modules only after the
 * env file and config have selected the service's database and SQLite library.
 */

import { parseArgs } from "node:util";
import { assertApiAuthConfigured } from "./api/auth";
import { loadConfig, loadEnvFile } from "./config";
import { validateStoredPackagedSyncPaths } from "./config/packaged-sync-paths";
import {
  preparePackagedBootstrapEnvironment,
  validatePackagedConfigPaths,
} from "./config/packaged-paths";
import { getMonzoParserPath, getPackagedResourceRoot } from "./runtime-paths";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      verbose: {
        type: "boolean",
        short: "v",
        default: false,
      },
      help: {
        type: "boolean",
        short: "h",
        default: false,
      },
      "check-config": {
        type: "boolean",
        default: false,
      },
      monzo: {
        type: "boolean",
        default: false,
      },
    },
    allowPositionals: true,
  });

  if (!values.monzo && positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }

  if (values.help) {
    console.log(`Timeline Service - Unified Entry Point

Usage:
  timeline-service [options]
  timeline-service monzo <command>

Options:
  -v, --verbose       Verbose output
  -h, --help          Show this help
      --check-config  Validate service configuration and exit

Environment Variables:
  TIMELINE_CONFIG     Config file path (default: ~/.config/timeline/config.toml)
  TIMELINE_DB_PATH    SQLite database path (default: ~/.local/share/timeline/timeline.db)
  TIMELINE_HOST       API server host (default: 127.0.0.1)
  TIMELINE_PORT       API server port (default: 3001)
`);
    return;
  }

  loadEnvFile();
  const packaged = getPackagedResourceRoot() !== null;
  if (packaged) preparePackagedBootstrapEnvironment();
  console.log("Loading configuration...");
  const config = await loadConfig();
  if (packaged) validatePackagedConfigPaths(config);

  // Database modules capture TIMELINE_DB_PATH at import time. Set every
  // bootstrap value from the fully resolved config before importing them.
  process.env.TIMELINE_DB_PATH = config.database.path;
  process.env.TIMELINE_HOST = config.server.host;
  process.env.TIMELINE_PORT = String(config.server.port);

  // sqlite-vec must select a custom SQLite library before any bun:sqlite
  // database is opened. Keep this import ahead of the runtime module graph.
  const { configureBunSqliteForSqliteVec } = await import("./embeddings/sqlite-vec");
  configureBunSqliteForSqliteVec();

  if (packaged) {
    const { SYNC_SOURCES } = await import("./sync/sources");
    await validateStoredPackagedSyncPaths(
      config.database.path,
      SYNC_SOURCES,
      config.sync,
    );
  }

  if (values["check-config"]) {
    assertApiAuthConfigured();
    console.log("Service configuration is valid.");
    return;
  }

  if (values.monzo) {
    const child = Bun.spawn(
      [process.execPath, getMonzoParserPath(), ...positionals],
      {
        env: process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }

  const { runService } = await import("./service-main");
  await runService(config, { verbose: values.verbose ?? false });
}

main().catch((error) => {
  // Timeline.app shows this line in its menu when the service is down.
  if (process.argv.includes("--check-config")) {
    console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
  } else {
    console.error("Fatal error:", error);
  }
  process.exit(1);
});
