/**
 * Shared state for `bun run dev` and its `dev:status` / `dev:stop` companions.
 *
 * A running dev server records itself in `.dev/state.json`. Processes are
 * identified by PID plus start time, never by command-line pattern, so a
 * stale state file or a reused PID cannot target an unrelated process.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const DEV_DIR = join(REPO_ROOT, ".dev");
export const STATE_PATH = join(DEV_DIR, "state.json");
export const LOG_PATH = join(DEV_DIR, "dev.log");

export type ProcessIdentity = {
  pid: number;
  /** Kernel start time, which distinguishes a reused PID. */
  startedAt: string;
};

export type DevState = {
  supervisor: ProcessIdentity;
  children: Array<ProcessIdentity & { name: string }>;
  status: "starting" | "ready";
  /** Started with --background (display only; signalling checks the process group). */
  background: boolean;
  webUrl: string;
  /** Local API URL; null when proxying to an external API. */
  apiUrl: string | null;
  externalApi: string | null;
  logFile: string | null;
};

/** `/proc/<pid>/stat` fields after the parenthesised command name, which may contain spaces. */
function procStatFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

function psField(pid: number, field: string): string | null {
  const result = Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().trim() || null;
}

/**
 * Start time of `pid`, or null if it is not running. Linux uses the exact
 * jiffies count from /proc (field 22), which unlike `ps -o lstart` does not
 * shift with clock adjustments; macOS has no /proc and reports a fixed
 * kernel timestamp through `ps`.
 */
export function processStartTime(pid: number): string | null {
  if (process.platform === "linux") {
    return procStatFields(pid)?.[19] ?? null;
  }
  return psField(pid, "lstart");
}

/** Process group of `pid`, or null if it is not running. */
export function processGroup(pid: number): number | null {
  const value = process.platform === "linux" ? procStatFields(pid)?.[2] : psField(pid, "pgid");
  return value ? Number(value) : null;
}

export function processIdentity(pid: number): ProcessIdentity {
  const startedAt = processStartTime(pid);
  if (!startedAt) throw new Error(`Cannot read start time of process ${pid}`);
  return { pid, startedAt };
}

/** True only if `identity` still names the same live process. */
export function isAlive(identity: ProcessIdentity): boolean {
  return processStartTime(identity.pid) === identity.startedAt;
}

export class CorruptStateError extends Error {}

function isIdentity(value: unknown): value is ProcessIdentity {
  const candidate = value as ProcessIdentity | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.startedAt === "string"
  );
}

/** Parses a state file, rejecting anything that could misdirect a signal. */
export function parseState(text: string, path = STATE_PATH): DevState {
  const corrupt = (reason: string) =>
    new CorruptStateError(`Unreadable dev state at ${path} (${reason}). Check for running processes, then remove it.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw corrupt("invalid JSON");
  }
  const state = parsed as DevState | null;
  if (typeof state !== "object" || state === null || !isIdentity(state.supervisor)) {
    throw corrupt("missing supervisor");
  }
  if (!Array.isArray(state.children) || !state.children.every(isIdentity)) {
    throw corrupt("missing or invalid children");
  }
  if (typeof state.webUrl !== "string") throw corrupt("missing webUrl");
  return state;
}

export function readState(path = STATE_PATH): DevState | null {
  if (!existsSync(path)) return null;
  return parseState(readFileSync(path, "utf8"), path);
}

/** Recorded processes still running, including children orphaned by a killed supervisor. */
export function liveProcesses(state: DevState, alive = isAlive): ProcessIdentity[] {
  return [state.supervisor, ...state.children].filter(alive);
}

/** The recorded dev server if any of its processes still run; stale state is removed. */
export function readLiveState(path = STATE_PATH): DevState | null {
  const state = readState(path);
  if (!state) return null;
  if (liveProcesses(state).length > 0) return state;
  rmSync(path, { force: true });
  return null;
}

function serialize(state: DevState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function writeState(state: DevState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, serialize(state));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Atomically records `state` as this worktree's dev server. Returns null on
 * success, or the live dev server that already holds the claim. Stale state
 * is replaced.
 */
export function claimState(state: DevState, path = STATE_PATH): DevState | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, serialize(state));
      } finally {
        closeSync(fd);
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLiveState(path);
      if (existing) return existing;
    }
  }
  throw new Error(`Could not claim ${path}: another dev server is starting`);
}

/** Removes the state file only if it still describes `supervisor`. */
export function clearState(supervisor: ProcessIdentity, path = STATE_PATH): void {
  let state: DevState | null;
  try {
    state = readState(path);
  } catch {
    return;
  }
  if (state && state.supervisor.pid === supervisor.pid && state.supervisor.startedAt === supervisor.startedAt) {
    rmSync(path, { force: true });
  }
}

export type StopDeps = {
  isAlive: (identity: ProcessIdentity) => boolean;
  processGroup: (pid: number) => number | null;
};

/**
 * PIDs to signal to stop `state`; negative values are process groups. The
 * group is signalled only when a recorded live process verifiably belongs to
 * the supervisor's own group (a --background run), which also reaches
 * unrecorded grandchildren such as Vite. Otherwise the supervisor shares its
 * caller's group, so only recorded processes are signalled: the supervisor,
 * which forwards to its children, or the children themselves if it died.
 */
export function stopTargets(state: DevState, deps: StopDeps): number[] {
  const { pid } = state.supervisor;
  const live = liveProcesses(state, deps.isAlive);
  if (live.length === 0) return [];
  if (live.some((identity) => deps.processGroup(identity.pid) === pid)) return [-pid];
  if (deps.isAlive(state.supervisor)) return [pid];
  return live.map((identity) => identity.pid);
}
