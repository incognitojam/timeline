/**
 * Storage Status Module
 *
 * Provides system storage information including:
 * - ZFS snapshot status
 * - Database file sizes and SQLite stats
 * - Disk space usage
 */

import { dirname, join } from "path";
import { openReadonlyTimelineDb } from "../db/readonly";

import { getTimelineDbPath } from "../db/paths";

const TIMELINE_DB_PATH = getTimelineDbPath();
const APP_STATE_DB_PATH = join(dirname(TIMELINE_DB_PATH), "app-state.db");

// Cache for expensive operations
let storageCache: { data: StorageStatus; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

export interface ZfsSnapshot {
  name: string;
  creation: string;
  used: string;
}

export interface ZfsStatus {
  available: boolean;
  dataset: string | null;
  snapshots: ZfsSnapshot[];
  latestAge: number | null; // seconds since latest snapshot
  error: string | null;
}

export interface DatabaseStatus {
  timeline: { path: string; size: number };
  appState: { path: string; size: number };
  sqlite: {
    pageCount: number;
    pageSize: number;
    freelistCount: number;
  };
}

export interface DiskStatus {
  total: number;
  available: number;
  usedPercent: number;
}

export interface StorageStatus {
  zfs: ZfsStatus;
  database: DatabaseStatus;
  disk: DiskStatus;
  cachedAt: string;
}

/**
 * Run a shell command with timeout
 */
async function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 5000
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => {
      proc.kill();
    }, timeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timeout);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    return { success: exitCode === 0, stdout, stderr };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Detect the ZFS dataset containing the database
 */
async function detectZfsDataset(dbPath: string): Promise<string | null> {
  // Get the directory containing the database
  const dbDir = dirname(dbPath);

  // Use df to find the mount point
  const dfResult = await runCommand("df", [dbDir]);
  if (!dfResult.success) return null;

  // Parse df output - format: Filesystem ... Mounted on
  const lines = dfResult.stdout.trim().split("\n");
  if (lines.length < 2) return null;

  // Get the last column (mount point) from the second line
  const parts = lines[1].split(/\s+/);
  const mountPoint = parts[parts.length - 1];

  // Check if this mount point is a ZFS dataset
  const zfsResult = await runCommand("zfs", ["list", "-H", "-o", "name", mountPoint]);
  if (!zfsResult.success) return null;

  return zfsResult.stdout.trim() || null;
}

/**
 * Parse ZFS snapshot list output
 */
function parseZfsSnapshots(output: string): ZfsSnapshot[] {
  const lines = output.trim().split("\n").filter(Boolean);
  const snapshots: ZfsSnapshot[] = [];

  for (const line of lines) {
    // Format: name\tcreation\tused
    const parts = line.split("\t");
    if (parts.length >= 3) {
      snapshots.push({
        name: parts[0],
        creation: parts[1],
        used: parts[2],
      });
    }
  }

  return snapshots;
}

/**
 * Get ZFS snapshot status
 */
async function getZfsStatus(): Promise<ZfsStatus> {
  // Check if zfs command exists
  const versionCheck = await runCommand("zfs", ["version"], 2000);
  if (!versionCheck.success) {
    return {
      available: false,
      dataset: null,
      snapshots: [],
      latestAge: null,
      error: "ZFS not installed",
    };
  }

  // Detect the dataset
  const dataset = await detectZfsDataset(TIMELINE_DB_PATH);
  if (!dataset) {
    return {
      available: false,
      dataset: null,
      snapshots: [],
      latestAge: null,
      error: "Database not on ZFS filesystem",
    };
  }

  // Get snapshots for this dataset
  const snapshotResult = await runCommand("zfs", [
    "list",
    "-t",
    "snapshot",
    "-o",
    "name,creation,used",
    "-s",
    "creation",
    "-H",
    "-r", // recursive - include child datasets
    dataset,
  ]);

  if (!snapshotResult.success) {
    if (snapshotResult.stderr.includes("permission denied")) {
      return {
        available: true,
        dataset,
        snapshots: [],
        latestAge: null,
        error: "Permission denied - may need sudo",
      };
    }
    return {
      available: true,
      dataset,
      snapshots: [],
      latestAge: null,
      error: snapshotResult.stderr.trim() || "Failed to list snapshots",
    };
  }

  const snapshots = parseZfsSnapshots(snapshotResult.stdout);

  // Calculate age of latest snapshot
  let latestAge: number | null = null;
  if (snapshots.length > 0) {
    const latest = snapshots[snapshots.length - 1];
    // ZFS creation format varies by locale, try to parse it
    const creationDate = new Date(latest.creation);
    if (!isNaN(creationDate.getTime())) {
      latestAge = Math.floor((Date.now() - creationDate.getTime()) / 1000);
    }
  }

  return {
    available: true,
    dataset,
    snapshots,
    latestAge,
    error: null,
  };
}

/**
 * Get database file sizes and SQLite stats
 */
function getDatabaseStatus(): DatabaseStatus {
  const db = openReadonlyTimelineDb();

  // Get file sizes
  let timelineSize = 0;
  let appStateSize = 0;

  try {
    timelineSize = Bun.file(TIMELINE_DB_PATH).size;
  } catch {
    // File might not exist
  }

  try {
    appStateSize = Bun.file(APP_STATE_DB_PATH).size;
  } catch {
    // File might not exist
  }

  // Get SQLite stats
  let pageCount = 0;
  let pageSize = 4096;
  let freelistCount = 0;
  try {
    pageCount = (db.prepare("PRAGMA page_count").get() as { page_count: number })?.page_count ?? 0;
    pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number })?.page_size ?? 4096;
    freelistCount = (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number })?.freelist_count ?? 0;
  } finally {
    db.close();
  }

  return {
    timeline: { path: TIMELINE_DB_PATH, size: timelineSize },
    appState: { path: APP_STATE_DB_PATH, size: appStateSize },
    sqlite: {
      pageCount,
      pageSize,
      freelistCount,
    },
  };
}

/**
 * Get disk space for the database partition
 */
async function getDiskStatus(): Promise<DiskStatus> {
  const dbDir = dirname(TIMELINE_DB_PATH);

  // Use df with -B1 for bytes (Linux) or just df (macOS)
  let result = await runCommand("df", ["-B1", dbDir]);
  if (!result.success) {
    // Try without -B1 for macOS
    result = await runCommand("df", ["-k", dbDir]);
  }

  if (!result.success) {
    return { total: 0, available: 0, usedPercent: 0 };
  }

  // Parse df output
  const lines = result.stdout.trim().split("\n");
  if (lines.length < 2) {
    return { total: 0, available: 0, usedPercent: 0 };
  }

  // Parse the values (format varies slightly between systems)
  const parts = lines[1].split(/\s+/);
  // Typically: Filesystem, Size/1K-blocks, Used, Available, Use%, Mounted
  // Index depends on format, but available is usually 4th numeric column

  let total = 0;
  let available = 0;

  if (parts.length >= 4) {
    // Check output format to determine multiplier
    // -B1 shows "1B-blocks" (bytes), -k shows "1K-blocks" (KB)
    let multiplier = 1;
    if (result.stdout.includes("1B-blocks")) {
      multiplier = 1; // Already in bytes
    } else if (result.stdout.includes("1K-blocks")) {
      multiplier = 1024; // Kilobytes
    } else if (result.stdout.includes("512-blocks")) {
      multiplier = 512;
    } else {
      multiplier = 1024; // Default assumption for -k
    }
    total = parseInt(parts[1]) * multiplier || 0;
    available = parseInt(parts[3]) * multiplier || 0;
  }

  const used = total - available;
  const usedPercent = total > 0 ? Math.round((used / total) * 100) : 0;

  return { total, available, usedPercent };
}

/**
 * Get complete storage status (with caching)
 */
export async function getStorageStatus(forceRefresh = false): Promise<StorageStatus> {
  const now = Date.now();

  // Return cached data if still valid
  if (!forceRefresh && storageCache && now - storageCache.fetchedAt < CACHE_TTL_MS) {
    return storageCache.data;
  }

  // Fetch all stats in parallel
  const [zfs, disk] = await Promise.all([
    getZfsStatus(),
    getDiskStatus(),
  ]);

  // Database status is synchronous
  const database = getDatabaseStatus();

  const data: StorageStatus = {
    zfs,
    database,
    disk,
    cachedAt: new Date().toISOString(),
  };

  // Cache the result
  storageCache = { data, fetchedAt: now };

  return data;
}
