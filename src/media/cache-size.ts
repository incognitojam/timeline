import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Fresh estimate of the eviction inventory's logical bytes. Only by-hash
 * entries count: source hardlinks must not inflate the cache. Count links
 * separately here because the planner sums each hash/extension, even when two
 * extensions share an inode. Apparent size includes sparse/compressed bytes;
 * following symlinks matches statByHash. Directories and unregistered blobs can
 * overestimate, but only the full inventory is allowed to select deletions.
 *
 * This is a live walk, not a snapshot (as with the full inventory). A concurrent
 * restore after a directory was visited is seen on the next scheduled run;
 * nothing is cached between runs. Case-insensitive volumes can count extension
 * aliases once while the planner counts each spelling. The scheduled caller
 * therefore reconciles periodically even when this estimate stays below its
 * limit. An incomplete walk must never authorize a skip.
 */
export async function mediaCacheSizeEstimate(mediaRoot: string): Promise<number | null> {
  const apparentSize = process.platform === "darwin" ? "-A" : "--apparent-size";
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  try {
    const { stdout } = await execFileAsync("du", [
      apparentSize, "-k", "-s", "-l", "-L", resolve(mediaRoot, "by-hash"),
    ], { timeout: 30_000, env: { ...process.env, LC_ALL: "C" } });
    const match = /^(\d+)\t[^\n]+\n?$/.exec(stdout);
    if (!match) return null;
    // du rounds UP to KiB; never round down before comparing with the limit.
    const bytes = Number(match[1]) * 1024;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    // Missing du/root, unsupported flags, permissions, vanished files, timeout:
    // uncertainty costs a full inventory, never a missed eviction.
    return null;
  }
}
