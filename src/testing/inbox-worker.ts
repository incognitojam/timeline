/**
 * Runs one inbox source through processSource on a worker thread, as the
 * service's scheduler worker does: process.exit ends this thread with its code,
 * and process.argv holds no CLI arguments.
 */

import { parentPort, workerData } from "worker_threads";
import type { InboxConfig, InboxSourceConfig } from "../inbox/config";

export interface InboxWorkerData {
  dbPath: string;
  tmpDir: string;
  config: InboxConfig;
  sourceName: string;
  source: InboxSourceConfig;
}

const { dbPath, tmpDir, config, sourceName, source } = workerData as InboxWorkerData;

// Database modules read the path at import time, and workers don't get the
// test preload's environment.
process.env.TIMELINE_DB_PATH = dbPath;
process.env.TMPDIR = tmpDir;

const { processSource } = await import("../inbox/process");
const result = await processSource(config, sourceName, source, {});
parentPort?.postMessage(result);
