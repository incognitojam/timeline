#!/usr/bin/env bun
import { $ } from "bun";
import { Database } from "bun:sqlite";
import { parseArgs, type ParseArgsConfig } from "util";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { parse as parseTOML } from "@iarna/toml";
import { expandPath } from "../src/config";

// --- Resolve the host's production DB ---
//
// prepare-sample / prepare-full source from the local Timeline host. "Prod" is
// the [database].path in the *global* host config (~/.config/timeline/config.toml),
// read directly rather than via loadConfig() — the latter honors TIMELINE_DB_PATH
// and a cwd-relative ./timeline.db, so inside a worktree it would resolve to that
// worktree's own sample and the script would try to sample from itself.
const HOST_CONFIG = join(homedir(), ".config", "timeline", "config.toml");
const DEFAULT_PROD_DB = join(homedir(), ".local", "share", "timeline", "timeline.db");

function resolveProdDb(): string {
  if (!existsSync(HOST_CONFIG)) return DEFAULT_PROD_DB;
  try {
    const parsed = parseTOML(readFileSync(HOST_CONFIG, "utf8")) as { database?: { path?: unknown } };
    const path = parsed.database?.path;
    return typeof path === "string" ? expandPath(path) : DEFAULT_PROD_DB;
  } catch (err) {
    console.error(`Warning: could not read ${HOST_CONFIG}: ${(err as Error).message}`);
    return DEFAULT_PROD_DB;
  }
}

const PROD_DB = resolveProdDb();

// Local cache
const CACHE_DIR = join(homedir(), ".local", "share", "timeline");
const CACHE_SAMPLE_PATH = join(CACHE_DIR, "sample.db");
const CACHE_SAMPLE_NO_CONTACTS_PATH = join(CACHE_DIR, "sample-no-contacts.db");
// NB: distinct from the host DB filename (timeline.db) — on the host the cache
// dir *is* the prod data dir, so a "timeline.db" cache would alias the live DB.
const CACHE_FULL_PATH = join(CACHE_DIR, "full.db");
const SAMPLER = join(import.meta.dir, "..", "src", "scripts", "sample-database.ts");

// --- Argument parsing ---

const parseArgsConfig = {
  args: process.argv.slice(2),
  options: {
    refresh: { type: "boolean", default: false },
    percent: { type: "string" },
    "no-contacts": { type: "boolean", default: false },
    full: { type: "boolean", default: false },
    "no-copy": { type: "boolean", default: false },
    summary: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
} as const satisfies ParseArgsConfig;

let values: ReturnType<typeof parseArgs<typeof parseArgsConfig>>["values"];
try {
  ({ values } = parseArgs(parseArgsConfig));
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  console.error("Run with --help for usage information.");
  process.exit(1);
}

if (values.help) {
  console.log(`Usage: scripts/prepare-sample-db.ts [--refresh] [--percent=N] [--no-contacts] [--full] [--no-copy] [--summary]

Generates a sample (default) or full copy of the local Timeline host database
and writes it to ./timeline.db for development.

Source: [database].path from ~/.config/timeline/config.toml
        (default: ${DEFAULT_PROD_DB})
        Existing caches under ${CACHE_DIR} can be reused without a host DB.

Options:
  --refresh       Force regeneration of the cached database
  --percent=N     Percentage of events to sample (default: 1)
  --no-contacts   Skip contact/identity tables in the sample (sample mode only)
  --full          Copy the full host DB (copy-on-write where supported)
  --no-copy       Populate the cache only (skip ./timeline.db)
  --summary       Print event count summary (slow for the full DB)`);
  process.exit(0);
}

const full = values.full!;
const noContacts = values["no-contacts"]!;
const noCopy = values["no-copy"]!;
const percentSet = values.percent !== undefined;
const percent = percentSet ? Number(values.percent) : 1;
if (percentSet && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
  console.error(`Error: --percent must be a number between 0 and 100, got '${values.percent}'`);
  process.exit(1);
}

let refresh = values.refresh!;
let showSummary = values.summary!;

if (full && percentSet) {
  console.error("Error: --full and --percent are mutually exclusive");
  process.exit(1);
}
if (full && noContacts) {
  console.error("Error: --no-contacts has no effect with --full (the full DB includes contacts)");
  process.exit(1);
}

if (percentSet) refresh = true;
if (!showSummary && !full && !noCopy) showSummary = true;

// The no-contacts sample caches under its own filename (mirroring the full/sample
// split) so a later default `prepare-sample` never silently reuses a contactless DB.
const sampleCachePath = noContacts ? CACHE_SAMPLE_NO_CONTACTS_PATH : CACHE_SAMPLE_PATH;
const cachePath = full ? CACHE_FULL_PATH : sampleCachePath;

// Safety: never read-from-and-write-to the live host DB. Cloning PROD_DB onto
// itself (mv over the open inode) splits the running service off the path — so
// hard-refuse if any output target resolves to PROD_DB, before touching anything.
const PROD_RESOLVED = resolve(PROD_DB);
function refuseIfProd(path: string, label: string): void {
  if (resolve(path) === PROD_RESOLVED) {
    console.error(`Error: refusing to use the live host DB (${PROD_DB}) as ${label}.`);
    process.exit(1);
  }
}
refuseIfProd(cachePath, "the cache");
if (!noCopy) refuseIfProd("./timeline.db", "the dev copy — run from a worktree, not the host data dir");

// --- Helpers ---

function formatAge(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function getFileAgeSeconds(filePath: string): number {
  return Math.floor((Date.now() - Bun.file(filePath).lastModified) / 1000);
}

function megabytes(filePath: string): string {
  return (statSync(filePath).size / (1024 * 1024)).toFixed(1);
}

async function cloneFile(src: string, dest: string): Promise<void> {
  // COPYFILE_FICLONE requests a copy-on-write clone where the filesystem
  // supports it and falls back to a regular copy elsewhere.
  // (WAL handling for the live-DB case is documented at the --full call site.)
  copyFileSync(src, dest, constants.COPYFILE_FICLONE);
}

function checkpointAndVerify(dbPath: string): void {
  // Fold the freshly-written sample's WAL into the file (so the cached copy is
  // self-contained) and verify integrity in the same connection.
  const db = new Database(dbPath);
  try {
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const row = db.query("PRAGMA quick_check").get() as { quick_check: string } | null;
    if ((row?.quick_check ?? "") !== "ok") {
      throw new Error(`SQLite integrity check failed: ${row?.quick_check}`);
    }
  } finally {
    db.close();
  }
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

// --- Generate cache if needed ---
//
// An existing cache is reused regardless of age — pass --refresh (or --percent,
// which implies it) to regenerate.
const needsRefresh = refresh || !existsSync(cachePath);

if (needsRefresh) {
  // No remote fallback: generating a cache requires the canonical Timeline host
  // database on this machine. A previously populated cache remains portable and
  // can be reused in development environments without the host database.
  if (!existsSync(PROD_DB)) {
    console.error(`Error: no Timeline database found at ${PROD_DB}`);
    console.error(`No reusable cache exists at ${cachePath}.`);
    console.error("Run this on the Timeline host, point [database].path at your DB, or copy a");
    console.error(`prepared database to ${cachePath}.`);
    process.exit(1);
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const tmpPath = `${cachePath}.tmp`;
  rmSync(tmpPath, { force: true });
  rmSync(`${tmpPath}-wal`, { force: true });
  rmSync(`${tmpPath}-shm`, { force: true });

  if (full) {
    console.log(`Cloning full host DB (${megabytes(PROD_DB)}M) from ${PROD_DB}...`);
    // Clone only the main DB file, not timeline.db-wal — deliberately. The clone
    // is a *consistent* snapshot (WAL mode keeps the main .db valid at the last
    // checkpoint) but omits whatever sits uncheckpointed in the -wal, so it can
    // lag the live DB by the most recent committed writes. That
    // is fine for a dev snapshot — NOT a backup — and immaterial for testing
    // migrations/backfills against the bulk history. A WAL-consistent copy (VACUUM
    // INTO / checkpoint-then-copy) would rewrite the whole database, defeating
    // the instant clonefile; checkpoint the host first if you need the exact latest.
    // (Cloning the live -wal alongside is not done — the pair could be captured
    // mid-write and reconstruct inconsistently.)
    await cloneFile(PROD_DB, tmpPath);
    await $`mv -f ${tmpPath} ${cachePath}`;
  } else {
    console.log(`Generating ${percent}% sample from ${PROD_DB}...`);
    const args = [PROD_DB, tmpPath, `--percent=${percent}`, "--min-per-type=5"];
    if (noContacts) args.push("--no-contacts");
    const proc = Bun.spawn([process.execPath, SAMPLER, ...args], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, TIMELINE_DB_PATH: PROD_DB },
    });
    if ((await proc.exited) !== 0) {
      console.error("Error: sample-database.ts failed");
      process.exit(1);
    }
    checkpointAndVerify(tmpPath);
    await $`mv -f ${tmpPath} ${cachePath}`;
  }
  console.log(`Cache: ${cachePath} (${megabytes(cachePath)}M)`);
} else {
  const label = full ? "full database" : "sample";
  console.log(
    `Using cached ${label} (${megabytes(cachePath)}M, age ${formatAge(getFileAgeSeconds(cachePath) * 1000)}) — pass --refresh to regenerate`,
  );
}

// --- Copy to workspace ---

let summaryDb: string;

if (noCopy) {
  console.log("\nSkipping copy to ./timeline.db (--no-copy)");
  summaryDb = cachePath;
} else {
  console.log("\nCopying to ./timeline.db...");
  // Remove stale WAL/SHM from any previous database to avoid schema corruption.
  rmSync("./timeline.db", { force: true });
  rmSync("./timeline.db-wal", { force: true });
  rmSync("./timeline.db-shm", { force: true });
  await cloneFile(cachePath, "./timeline.db");
  summaryDb = "./timeline.db";

  if (existsSync(".no-local-db")) {
    rmSync(".no-local-db");
    console.log("Removed .no-local-db");
  }
}

// --- Print summary ---

if (showSummary) {
  const db = new Database(summaryDb);
  try {
    const countRow = db.query("SELECT COUNT(*) as count FROM events").get() as { count: number };
    const pairsRow = db
      .query("SELECT COUNT(DISTINCT source || ':' || type) as count FROM events")
      .get() as { count: number };
    const displayPath = noCopy ? summaryDb : "./timeline.db";
    console.log(`\nReady! ${displayPath} has ${countRow.count} events across ${pairsRow.count} (source, type) pairs`);
  } finally {
    db.close();
  }
} else {
  console.log("\nReady! Summary skipped (use --summary to print counts)");
}
