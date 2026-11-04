#!/usr/bin/env bun
/**
 * bun run sync:once <source> — run one sync source once against scratch data.
 *
 * Application modules read host paths (~/.config/timeline, os.homedir()) as they
 * load, and Bun fixes os.homedir() at startup, so this file imports none of them.
 * It prepares a sandbox and re-runs once-main.ts in a child process, in that
 * empty directory, whose environment holds only the sandbox paths and what the
 * caller passes.
 */

import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { APP_STATE_DB_FILE, EMBEDDINGS_DB_FILE } from "../db/sibling-files";

const USAGE = `Usage: bun run sync:once <source> [options]

Runs one sync source's canSync() and sync() in-process against a scratch
database, then prints the SyncResult, the events it changed, and sync_state.

Options:
  --sandbox <dir>      Directory for the run's HOME, config, media, and inbox.
                       Default: a fresh .sync-once/<source>-<time>/ in the repo
  --db <path>          Timeline database to use; app-state.db sits beside it.
                       Default: timeline.db in the sandbox
  --set <key=value>    Source setting, checked against its configSchema.
                       Repeat for several settings or list entries.
  --state-json <file>  JSON object of sync_state rows to write before the run,
                       keyed by sync_state.source, e.g. {"amp": {...}}
  --env <KEY=VALUE>    Pass one environment variable to the source. Repeatable.
  --env-file <file>    Load a Timeline env file (KEY=value lines) for the source.
  --home-file <path=file>  Copy file to path relative to the sandbox HOME, for
                       sources configured by files, e.g.
                       .config/timeline/github.json=./fixtures/github.json
  --config <file>      Copy file to the sandbox's config.toml. Database, media,
                       and inbox paths stay in the sandbox; inbox destinations
                       outside it are refused.
  --dry-run            Write the settings and state, then call canSync() but not
                       sync(), all against sandbox copies of the databases.
  --json               Print the report as JSON.
  --verbose            Let the source log progress.
  -h, --help           Show this help.

The source runs with HOME, config, media, and inbox inside the sandbox
directory and no other environment, so it never reads host credentials
unless they are passed with --env, --env-file, --home-file, --config,
--state-json, or --set.`;

/** Variables a source needs to run but that carry no credentials. */
const PASSTHROUGH_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "NO_COLOR", "FORCE_COLOR"];

export const EXIT_USAGE = 2;

class UsageError extends Error {}

function parseEnvAssignment(assignment: string): [string, string] {
  const separator = assignment.indexOf("=");
  if (separator <= 0) throw new UsageError(`--env expects KEY=VALUE, got "${assignment}"`);
  return [assignment.slice(0, separator), assignment.slice(separator + 1)];
}

export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/** Follows every symlink, including a dangling one SQLite would create its target through. */
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return canonical(resolve(parent, readlinkSync(path)));
  }
  return join(canonical(parent), basename(path));
}

function assertNotHostData(path: string): void {
  const home = homedir();
  for (const dir of [join(home, ".local", "share", "timeline"), join(home, ".config", "timeline")]) {
    if (isInside(canonical(path), canonical(dir))) {
      throw new UsageError(`Refusing to use ${path}: it is inside host data at ${dir}`);
    }
  }
}

/** Every database a run opens, since a sibling of a scratch database can be a link to host data. */
function databaseFiles(dbPath: string): string[] {
  return [dbPath, join(dirname(dbPath), APP_STATE_DB_FILE), join(dirname(dbPath), EMBEDDINGS_DB_FILE)];
}

/** What SQLite keeps beside a database, named after its resolved path rather than a link to it. */
const SQLITE_SUFFIXES = ["", "-wal", "-shm", "-journal"];

function assertDatabasesNotHostData(dbPath: string): void {
  for (const file of databaseFiles(dbPath)) {
    for (const suffix of SQLITE_SUFFIXES) {
      assertNotHostData(file + suffix);
      assertNotHostData(canonical(file) + suffix);
    }
  }
}

function copyDatabases(dbPath: string, targetDb: string): void {
  mkdirSync(dirname(targetDb), { recursive: true });
  const targets = databaseFiles(targetDb);
  databaseFiles(dbPath).forEach((file, index) => {
    const from = canonical(file);
    for (const suffix of SQLITE_SUFFIXES) {
      if (existsSync(from + suffix)) copyFileSync(from + suffix, targets[index] + suffix, constants.COPYFILE_FICLONE);
    }
  });
}

function assertFile(flag: string, path: string): void {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) throw new UsageError(`${flag} ${path} does not exist`);
  if (!stat.isFile()) throw new UsageError(`${flag} ${path} is not a file`);
}

function parseHomeFile(spec: string): { target: string; from: string } {
  const separator = spec.indexOf("=");
  const target = separator > 0 ? normalize(spec.slice(0, separator)) : "";
  const from = resolve(spec.slice(separator + 1));
  if (!target || isAbsolute(target) || target === ".." || target.startsWith(`..${sep}`)) {
    throw new UsageError(`--home-file expects a path inside HOME and a file, as path=file; got "${spec}"`);
  }
  assertFile("--home-file source", from);
  return { target, from };
}

function readStateFile(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`Cannot read --state-json ${path}: ${error instanceof Error ? error.message : error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`--state-json ${path} must hold a JSON object keyed by sync_state.source`);
  }
  return parsed as Record<string, unknown>;
}

/** The child's whole environment: sandbox paths, harmless passthrough, and explicit --env values. */
function buildChildEnv(sandbox: string, dbPath: string, envFile: string | undefined, assignments: string[]) {
  const sandboxEnv: Record<string, string> = {
    HOME: join(sandbox, "home"),
    TMPDIR: join(sandbox, "tmp"),
    TIMELINE_CONFIG: join(sandbox, "config.toml"),
    TIMELINE_ENV_FILE: envFile ?? join(sandbox, "env"),
    TIMELINE_DB_PATH: dbPath,
    TIMELINE_EMBEDDINGS_DB_PATH: join(dirname(dbPath), EMBEDDINGS_DB_FILE),
    TIMELINE_MEDIA_PATH: join(sandbox, "media"),
    TIMELINE_INBOX_PATH: join(sandbox, "inbox"),
  };
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const assignment of assignments) {
    const [key, value] = parseEnvAssignment(assignment);
    if (key in sandboxEnv) throw new UsageError(`--env cannot override ${key}; it points into the sandbox`);
    env[key] = value;
  }
  Object.assign(env, sandboxEnv);

  return { sandboxEnv, env };
}

function parseCliArgs() {
  return parseArgs({
    allowPositionals: true,
    options: {
      sandbox: { type: "string" },
      db: { type: "string" },
      set: { type: "string", multiple: true, default: [] },
      "state-json": { type: "string" },
      env: { type: "string", multiple: true, default: [] },
      "env-file": { type: "string" },
      "home-file": { type: "string", multiple: true, default: [] },
      config: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function existingFile(flag: string, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const resolved = resolve(path);
  assertFile(flag, resolved);
  return resolved;
}

function resolveSandbox(requested: string | undefined, sourceName: string): string {
  if (requested) {
    const sandbox = resolve(requested);
    const stat = statSync(sandbox, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || readdirSync(sandbox).length > 0)) {
      throw new UsageError(`--sandbox ${sandbox} must be an empty directory or absent`);
    }
    return sandbox;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(resolve(import.meta.dir, "../.."), ".sync-once", `${sourceName}-${stamp}`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseCliArgs();
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError(`Expected exactly one source name\n\n${USAGE}`);
  const [sourceName] = positionals;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(sourceName)) throw new UsageError(`Invalid source name "${sourceName}"`);

  const state = values["state-json"] ? readStateFile(resolve(values["state-json"])) : undefined;
  const envFile = existingFile("--env-file", values["env-file"]);
  const configFile = existingFile("--config", values.config);
  const homeFiles = values["home-file"].map(parseHomeFile);

  const sandbox = resolveSandbox(values.sandbox, sourceName);
  const requestedDb = values.db ? resolve(values.db) : join(sandbox, "timeline.db");
  if (statSync(requestedDb, { throwIfNoEntry: false })?.isDirectory()) {
    throw new UsageError(`--db ${requestedDb} is a directory`);
  }
  assertDatabasesNotHostData(requestedDb);
  assertNotHostData(sandbox);
  // canSync() may write, so a dry run on a caller's database works on copies of it.
  const dbPath = values["dry-run"] && values.db ? join(sandbox, "dry-run", basename(requestedDb)) : requestedDb;

  const { sandboxEnv, env } = buildChildEnv(sandbox, dbPath, envFile, values.env);

  // The sandbox was checked empty or absent, so everything in it from here is ours.
  const createdRoot = mkdirSync(sandbox, { recursive: true });
  const removeSandbox = () => {
    if (createdRoot) rmSync(values.sandbox ? createdRoot : sandbox, { recursive: true, force: true });
    else for (const entry of readdirSync(sandbox)) rmSync(join(sandbox, entry), { recursive: true, force: true });
  };

  try {
    for (const dir of ["home", "tmp", "media", "inbox"]) mkdirSync(join(sandbox, dir));
    if (dbPath !== requestedDb) copyDatabases(requestedDb, dbPath);
    if (configFile) copyFileSync(configFile, sandboxEnv.TIMELINE_CONFIG);
    else writeFileSync(sandboxEnv.TIMELINE_CONFIG, "");
    if (!envFile) writeFileSync(sandboxEnv.TIMELINE_ENV_FILE, "");
    for (const { target, from } of homeFiles) {
      const to = join(sandboxEnv.HOME, target);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  } catch (error) {
    removeSandbox();
    throw new UsageError(`Could not prepare the sandbox: ${error instanceof Error ? error.message : error}`);
  }

  console.error(`sync:once sandbox ${relative(process.cwd(), sandbox) || "."}`);
  console.error(`sync:once database ${relative(process.cwd(), dbPath)}`);

  const request = {
    source: sourceName,
    set: values.set,
    state,
    dryRun: values["dry-run"],
    json: values.json,
    verbose: values.verbose,
    callerDir: process.cwd(),
  };
  // Bun loads .env from a process's working directory. The sandbox has none, which
  // covers every Bun process the source starts; --no-env-file states it for this one.
  const childArgs = [process.execPath, "--no-env-file", join(import.meta.dir, "once-main.ts"), JSON.stringify(request)];
  const child = Bun.spawn(childArgs, {
    cwd: sandbox,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  // A rejected request leaves nothing behind.
  if (exitCode === EXIT_USAGE) removeSandbox();
  return exitCode;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof UsageError || (error instanceof TypeError && "code" in error)) {
        console.error(`sync:once: ${error.message}`);
        process.exit(EXIT_USAGE);
      }
      throw error;
    },
  );
}
