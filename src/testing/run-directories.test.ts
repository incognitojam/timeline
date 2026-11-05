import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "fs";
import * as os from "os";
import { join } from "path";
import {
  currentPidNamespace,
  removeStaleRunDirectories,
  runDirectoryPrefix,
  UNVERIFIABLE_MAX_AGE_MS,
} from "./run-directories";

const OTHER_NAMESPACE = "pidns1";

function tempParent(): string {
  return mkdtempSync(join(os.tmpdir(), "run-directories-"));
}

function runDirectory(parent: string, name: string, ageMs = 0): string {
  const path = join(parent, name);
  mkdirSync(path);
  const modified = new Date(Date.now() - ageMs);
  utimesSync(path, modified, modified);
  return path;
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

function canUnshare(): boolean {
  try {
    return Bun.spawnSync(["unshare", "-Urpf", "--mount-proc", "true"]).exitCode === 0;
  } catch {
    return false;
  }
}

describe("removeStaleRunDirectories", () => {
  const expired = UNVERIFIABLE_MAX_AGE_MS + 60_000;

  test("removes a directory whose owner in this namespace is dead", async () => {
    const parent = tempParent();
    const dir = runDirectory(parent, `timeline-test-run-${currentPidNamespace()}-${await deadPid()}-abc123`);

    removeStaleRunDirectories(parent);

    expect(existsSync(dir)).toBe(false);
  });

  test("never expires a directory whose owner in this namespace is alive", () => {
    const parent = tempParent();
    const dir = runDirectory(parent, `${runDirectoryPrefix()}abc123`, expired);

    removeStaleRunDirectories(parent);

    expect(existsSync(dir)).toBe(true);
  });

  test("keeps a recent directory from another namespace whose pid isn't visible here", async () => {
    const parent = tempParent();
    const dir = runDirectory(parent, `timeline-test-run-${OTHER_NAMESPACE}-${await deadPid()}-abc123`);

    removeStaleRunDirectories(parent);

    expect(existsSync(dir)).toBe(true);
  });

  test("removes an expired directory from another namespace", async () => {
    const parent = tempParent();
    const dir = runDirectory(parent, `timeline-test-run-${OTHER_NAMESPACE}-${await deadPid()}-abc123`, expired);

    removeStaleRunDirectories(parent);

    expect(existsSync(dir)).toBe(false);
  });

  test("trusts no pid when this run can't read its own namespace", async () => {
    const parent = tempParent();
    const pid = await deadPid();
    const unknown = runDirectory(parent, `timeline-test-run-unknown-${pid}-abc123`);
    const known = runDirectory(parent, `timeline-test-run-${currentPidNamespace()}-${pid}-abc123`);

    removeStaleRunDirectories(parent, null);

    expect(existsSync(unknown)).toBe(true);
    expect(existsSync(known)).toBe(true);
  });

  test("treats a name without a namespace as unverifiable", async () => {
    const parent = tempParent();
    const pid = await deadPid();
    const recent = runDirectory(parent, `timeline-test-run-${pid}-recent`);
    const old = runDirectory(parent, `timeline-test-run-${pid}-old000`, expired);

    removeStaleRunDirectories(parent);

    expect(existsSync(recent)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  test("leaves entries that aren't run directories alone, however old", () => {
    const parent = tempParent();
    const dirs = ["another-tool-1-abc123", "timeline-test-run-", "timeline-test-run-not-a-pid", "timeline-test-runner"].map(
      (name) => runDirectory(parent, name, expired),
    );

    removeStaleRunDirectories(parent);

    for (const dir of dirs) expect(existsSync(dir)).toBe(true);
  });

  // Needs unprivileged user namespaces, which macOS and some Linux hosts lack.
  test.skipIf(!canUnshare())("a run in a real PID namespace keeps a live run's directory", async () => {
    const parent = tempParent();
    const live = runDirectory(parent, `${runDirectoryPrefix()}abc123`);
    const script = `
      import { mkdirSync, existsSync } from "fs";
      import { currentPidNamespace, removeStaleRunDirectories } from ${JSON.stringify(join(import.meta.dir, "run-directories.ts"))};
      const parent = ${JSON.stringify(parent)};
      const dead = parent + "/timeline-test-run-" + currentPidNamespace() + "-${process.pid}-abc123";
      mkdirSync(dead);
      removeStaleRunDirectories(parent);
      console.log(JSON.stringify({
        namespace: currentPidNamespace(),
        ownerVisible: (() => { try { process.kill(${process.pid}, 0); return true; } catch { return false; } })(),
        deadRemoved: !existsSync(dead),
      }));
    `;

    const child = Bun.spawn(["unshare", "-Urpf", "--mount-proc", process.execPath, "--no-env-file", "-e", script]);
    const output = await new Response(child.stdout).text();

    expect(await child.exited).toBe(0);
    const result = JSON.parse(output);
    expect(result.namespace).not.toBe(currentPidNamespace());
    expect(result.ownerVisible).toBe(false);
    expect(result.deadRemoved).toBe(true);
    expect(existsSync(live)).toBe(true);
  });
});
