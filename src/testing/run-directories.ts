/**
 * Finds test run directories left behind by runs killed before their cleanup.
 *
 * A pid only identifies a process within one PID namespace, and sandboxes can
 * share a temporary directory while having their own namespace. So a directory's
 * name carries its owner's namespace as well as its pid, set atomically by
 * mkdtemp, and only a run in that namespace may conclude from the pid that the
 * owner is dead. A namespace id can be reused, but only once every process in the
 * old namespace has exited, so a matching id never hides a live owner elsewhere.
 */

import { readdirSync, readlinkSync, rmSync, statSync } from "fs";
import { join } from "path";

const PREFIX = "timeline-test-run-";
// The namespace is absent from directories created before names carried one.
const RUN_DIRECTORY_NAME = new RegExp(`^${PREFIX}(?:([^-]+)-)?(\\d+)-[^-]+$`);

// The only cleanup for directories whose owner can't be checked: those from
// another namespace or from before names carried one. It must outlast any run
// that is still alive, which has no way to renew its directory.
export const UNVERIFIABLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Null when this Linux process can't read its namespace. Other platforms have a single pid space. */
export function currentPidNamespace(): string | null {
  if (process.platform !== "linux") return process.platform;
  try {
    const id = readlinkSync("/proc/self/ns/pid").match(/^pid:\[(\d+)\]$/)?.[1];
    return id ? `pidns${id}` : null;
  } catch {
    return null;
  }
}

/** The mkdtemp prefix for this run's directory. */
export function runDirectoryPrefix(): string {
  return `${PREFIX}${currentPidNamespace() ?? "unknown"}-${process.pid}-`;
}

export function removeStaleRunDirectories(parent: string, namespace = currentPidNamespace()): void {
  for (const entry of readdirSync(parent)) {
    const owner = entry.match(RUN_DIRECTORY_NAME);
    if (!owner) continue;
    const path = join(parent, entry);
    try {
      const stale = owner[1] === namespace ? !isAlive(Number(owner[2])) : isExpired(path);
      if (stale) rmSync(path, { recursive: true, force: true });
    } catch (error) {
      // Another user's leftovers must not stop this run.
      console.warn(`Could not remove stale test run directory ${entry}: ${error}`);
    }
  }
}

function isExpired(path: string): boolean {
  const modified = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
  return modified !== undefined && Date.now() - modified > UNVERIFIABLE_MAX_AGE_MS;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
