#!/usr/bin/env bun
/**
 * Synthetic development database: `bun run seed`.
 *
 * Writes timeline.db, app-state.db, and media/ for one fictional person (see
 * persona.ts) by generating a synthetic export for every source and running it
 * through that source's real importer. Re-running rebuilds from scratch, which
 * doubles as the reset for schema experiments.
 */
import { existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseDate, SeedContext, todayInSeedZone } from "./context";
import type { GeneratorImport } from "./app-state";
import { assertNotHostDataDir, assertReplaceableMedia, installBuild, SEED_MEDIA_MARKER } from "./install";
import { TIME_ZONE } from "./persona";

const USAGE = `Usage: bun run seed [--out=DIR] [--anchor=YYYY-MM-DD] [--only=a,b]

Generates three years of synthetic history (timeline.db, app-state.db, and
media/) for a fictional person, replacing any existing copies in the output
directory.

Options:
  --out=DIR            Output directory (default: the current directory)
  --anchor=YYYY-MM-DD  Last day of generated history (default: today in ${TIME_ZONE})
  --only=a,b           Run only the named generators (for working on one)
  --list               List generator names and exit`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string", default: "." },
    anchor: { type: "string" },
    only: { type: "string" },
    list: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const outDir = resolve(values.out ?? ".");
// Generators place eras on this span (Skype early on, SMS handing over to
// Google Messages, Fitbit to Google Health), so it is fixed rather than an option.
const YEARS = 3;
if (values.anchor !== undefined) parseDate(values.anchor);
if (values.only !== undefined && values.only.trim() === "") throw new Error("--only needs at least one generator name");

// The build happens in a scratch directory and is installed only once it is
// complete (see install.ts). Where a RAM-backed tmpfs with room for it exists
// (Linux) the build lives there: some importers run as separate processes that
// commit row by row, and on slow-fsync filesystems those commits would
// dominate the run.
const ramDir = hasRoom("/dev/shm", 1024 ** 3) ? "/dev/shm" : null;
const runId = `${process.pid}-${Date.now().toString(36)}`;
const buildDir = join(ramDir ?? outDir, `.seed-build-${runId}`);
const stagingRoot = join(ramDir ?? tmpdir(), `timeline-seed-staging-${runId}`);
const buildDbPath = join(buildDir, "timeline.db");
const buildMediaRoot = join(buildDir, "media");
const cleanUp = () => {
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(stagingRoot, { recursive: true, force: true });
};

// Modules that open the database read TIMELINE_DB_PATH when first imported, so
// point them at the build directory before loading anything from src/.
process.env.TIMELINE_DB_PATH = buildDbPath;
process.env.TIMELINE_MEDIA_PATH = buildMediaRoot;
// Never read the user's host config or secrets: a [media.r2] section would
// upload seeded media to a real bucket. Parser subprocesses inherit this env.
const seedConfigPath = join(buildDir, "config.toml");
process.env.TIMELINE_CONFIG = seedConfigPath;
process.env.TIMELINE_ENV_FILE_LOADED = "1";

const { getHostDbPath } = await import("../db/paths");
const { initDb } = await import("../db/schema");
const { initAppStateDb } = await import("../db/app-state");
const { Database } = await import("bun:sqlite");
const { SEED_SOURCES } = await import("./sources");
const { undeclaredEventPairs, undeclaredSeedPairs } = await import("../platforms/event-types");
const { seedContacts } = await import("./contacts");
const { seedAppState } = await import("./app-state");
const { processAttachmentThumbhashes } = await import("../media/thumbhash");

if (values.list) {
  for (const source of SEED_SOURCES) console.log(source.name);
  process.exit(0);
}

const only = values.only === undefined ? null : new Set(values.only.split(",").map((name) => name.trim()));
if (only) {
  const known = new Set(SEED_SOURCES.map((source) => source.name));
  const unknown = [...only].filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`Unknown generator(s): ${unknown.join(", ")} (see --list)`);
}
const selected = only ? SEED_SOURCES.filter((source) => only.has(source.name)) : SEED_SOURCES;
const undeclaredPromises = undeclaredSeedPairs(selected);
if (undeclaredPromises.length > 0) {
  throw new Error(`Generators promise event types their platforms don't declare: ${undeclaredPromises.join(", ")}`);
}

mkdirSync(outDir, { recursive: true });
assertNotHostDataDir(outDir, getHostDbPath());
assertReplaceableMedia(outDir);

const anchorDate = values.anchor ?? todayInSeedZone();
const started = performance.now();

// From here on the build and staging directories exist; remove them however
// the run ends, including Ctrl-C.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanUp();
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  });
}
mkdirSync(buildMediaRoot, { recursive: true });
mkdirSync(stagingRoot, { recursive: true });
writeFileSync(seedConfigPath, "# Generated by bun run seed: local media only, no remote backends.\n");

let summary: { events: number; pairs: number; attachments: number };
try {
  const db = new Database(buildDbPath);
  const appStateDb = new Database(join(buildDir, "app-state.db"));
  try {
    initDb(db);
    // The build is discarded on failure and checkpointed before install, so it
    // needs no per-commit fsync (importers that insert row by row pay one each).
    // A larger cache and mmap halve the in-process imports' insert time.
    db.exec("PRAGMA synchronous = OFF");
    db.exec("PRAGMA cache_size = -131072");
    db.exec("PRAGMA temp_store = MEMORY");
    db.exec("PRAGMA mmap_size = 268435456");
    appStateDb.exec("PRAGMA journal_mode = WAL");
    appStateDb.exec("PRAGMA foreign_keys = ON");
    appStateDb.exec("PRAGMA synchronous = OFF");
    initAppStateDb(appStateDb);

    const ctx = new SeedContext(db, buildDbPath, buildMediaRoot, stagingRoot, anchorDate, YEARS);
    console.log(`Seeding ${ctx.startDate} → ${anchorDate} for ${selected.length} generators`);
    const imports = await runGenerators(ctx, db);
    const undeclared = undeclaredEventPairs(db);
    if (undeclared.length > 0) {
      const pairs = undeclared.map(({ source, type }) => `${source}/${type}`).join(", ");
      throw new Error(`Importers wrote event types their platforms don't declare: ${pairs}`);
    }
    // What the service's upkeep syncs would do next: image placeholders.
    await quietly(() => processAttachmentThumbhashes(db, { concurrency: 8 }));
    seedContacts(ctx);
    seedAppState(ctx, appStateDb, selected, imports);
    // Read before install: on macOS's system SQLite, a read-only connection to the
    // installed file fails with SQLITE_CANTOPEN (no -wal), and a normal one with
    // SQLITE_IOERR_VNODE, because unfinalized statements keep this connection open.
    summary = db
      .query(
        `SELECT (SELECT COUNT(*) FROM events) AS events,
                (SELECT COUNT(DISTINCT source || ':' || type) FROM events) AS pairs,
                (SELECT COUNT(*) FROM attachments) AS attachments`,
      )
      .get() as typeof summary;
    for (const handle of [db, appStateDb]) handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
    appStateDb.close();
  }

  writeFileSync(join(buildMediaRoot, SEED_MEDIA_MARKER), "Generated by `bun run seed`; safe to delete.\n");
  installBuild(buildDir, outDir);
} finally {
  cleanUp();
}
rmSync(join(outDir, ".no-local-db"), { force: true });

const finalDbPath = join(outDir, "timeline.db");
console.log(
  `\nReady in ${((performance.now() - started) / 1000).toFixed(1)}s: ${summary.events} events across ` +
    `${summary.pairs} (source, type) pairs, ${summary.attachments} attachments → ${finalDbPath}`,
);

/** Run each generator, check its declared types, and record what each added. */
async function runGenerators(ctx: SeedContext, db: InstanceType<typeof Database>) {
  const lastId = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events");
  const since = db.prepare("SELECT COUNT(*) AS events, MAX(timestamp) AS newest FROM events WHERE id > ?");
  const check = db.prepare("SELECT 1 FROM events WHERE source = ? AND type = ? LIMIT 1");
  const imports = new Map<string, GeneratorImport>();
  for (const source of selected) {
    const t0 = performance.now();
    const before = (lastId.get() as { id: number }).id;
    await quietly(() => source.seed(ctx));
    const missing = Object.entries(source.produces).flatMap(([name, types]) =>
      types.filter((type) => !check.get(name, type)).map((type) => `${name}/${type}`),
    );
    if (missing.length > 0) throw new Error(`${source.name} produced no events for: ${missing.join(", ")}`);
    imports.set(source.name, since.get(before) as GeneratorImport);
    console.log(`  ${source.name.padEnd(20)} ${Math.round(performance.now() - t0)}ms`);
  }
  return imports;
}

/**
 * Importers narrate their progress; keep the seed's output to one line per
 * generator (warnings and errors still print).
 */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

/** Whether a directory exists and has at least `bytes` free. */
function hasRoom(dir: string, bytes: number): boolean {
  if (!existsSync(dir)) return false;
  const stats = statfsSync(dir);
  return stats.bavail * stats.bsize >= bytes;
}
