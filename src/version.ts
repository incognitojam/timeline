import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TIMELINE_REPO_ROOT } from "./repo-root";
import { getPackagedVersionPath } from "./runtime-paths";
import type { VersionInfo } from "./shared/version";

export { TIMELINE_REPO_ROOT } from "./repo-root";
export type { VersionInfo } from "./shared/version";

function gitVersionInfo(repoRoot: string): VersionInfo | null {
  if (!existsSync(join(repoRoot, ".git"))) return null;

  const git = (...args: string[]): string | null => {
    try {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "ignore",
      });
      if (result.exitCode !== 0) return null;
      const output = result.stdout.toString().trim();
      return output === "" ? null : output;
    } catch {
      return null;
    }
  };

  const commitFull = git("rev-parse", "HEAD");
  if (!commitFull) return null;
  return {
    commit: commitFull.slice(0, 7),
    commitFull,
    message: git("log", "-1", "--format=%s") ?? "",
    branch: git("rev-parse", "--abbrev-ref", "HEAD") ?? "",
  };
}

function parseVersionInfo(path: string, packaged = false): VersionInfo {
  const value = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!value || typeof value !== "object") {
    throw new Error(`Version metadata must be an object: ${path}`);
  }
  const fields = value as Record<string, unknown>;
  for (const field of ["commit", "commitFull", "message", "branch"] as const) {
    if (typeof fields[field] !== "string") {
      throw new Error(`Version metadata has an invalid ${field}: ${path}`);
    }
  }
  for (const field of ["commit", "commitFull"] as const) {
    if (fields[field] === "") {
      throw new Error(`Version metadata has an empty ${field}: ${path}`);
    }
  }
  for (const field of ["version", "build", "builtAt"] as const) {
    if (fields[field] !== undefined && typeof fields[field] !== "string") {
      throw new Error(`Version metadata has an invalid ${field}: ${path}`);
    }
  }
  if (fields.dirty !== undefined && typeof fields.dirty !== "boolean") {
    throw new Error(`Version metadata has an invalid dirty flag: ${path}`);
  }
  if (packaged) {
    for (const field of ["version", "build", "builtAt"] as const) {
      if (typeof fields[field] !== "string" || fields[field] === "") {
        throw new Error(`Packaged version metadata has an invalid ${field}: ${path}`);
      }
    }
    if (Number.isNaN(Date.parse(fields.builtAt as string))) {
      throw new Error(`Packaged version metadata has an invalid builtAt: ${path}`);
    }
  }
  return fields as unknown as VersionInfo;
}

export function loadVersionInfo(repoRoot = TIMELINE_REPO_ROOT): VersionInfo | null {
  const packagedVersionPath = getPackagedVersionPath();
  if (packagedVersionPath) {
    try {
      return parseVersionInfo(packagedVersionPath, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load packaged version metadata: ${message}`);
    }
  }

  // Source checkouts report Git directly; non-packaged legacy deployments may
  // still provide version.json at one of the fallback locations below.
  const fromGit = gitVersionInfo(repoRoot);
  if (fromGit) return fromGit;

  const candidates = [
    join(process.cwd(), "version.json"),
    join(repoRoot, "version.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return parseVersionInfo(candidate);
    } catch {
      // Continue to the next candidate. An invalid deploy artifact must not
      // prevent a valid one at the other supported location from loading.
    }
  }
  return null;
}

// Captured once so every surface reports the code the process actually booted,
// even if the checkout advances before the service restarts.
export const runningVersionInfo = loadVersionInfo();
