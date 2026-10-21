import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundCommand } from "./background-priority";

const darwinIt = process.platform === "darwin" ? it : it.skip;

/** Scheduling priority of a running process, as `ps` reports it (4 is background, 31 normal). */
function priorityOf(pid: number): number {
  return Number(Bun.spawnSync(["ps", "-o", "pri=", "-p", String(pid)]).stdout.toString().trim());
}

describe("background priority", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "background-priority-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves commands unchanged on a thread that was not lowered", () => {
    expect(backgroundCommand(["unzip", "-q", "a.zip"])).toEqual(["unzip", "-q", "a.zip"]);
  });

  darwinIt("runs commands spawned from a lowered worker thread at background priority", async () => {
    const workerPath = join(dir, "worker.ts");
    writeFileSync(
      workerPath,
      `import { backgroundCommand, lowerThreadToBackground } from ${JSON.stringify(join(import.meta.dir, "background-priority.ts"))};
lowerThreadToBackground();
const child = Bun.spawn(backgroundCommand(["sleep", "5"]));
postMessage(child.pid);
await Bun.sleep(1000);
child.kill();`
    );
    const worker = new Worker(workerPath);
    try {
      const childPid = await new Promise<number>((resolve, reject) => {
        worker.onmessage = event => resolve(event.data as number);
        worker.onerror = event => reject(new Error(event.message));
      });
      let priority = priorityOf(childPid);
      for (let attempt = 0; attempt < 20 && priority !== 4; attempt++) {
        await Bun.sleep(10);
        priority = priorityOf(childPid);
      }
      expect(priority).toBe(4);
    } finally {
      worker.terminate();
    }

    // The same command spawned from this unlowered thread keeps normal priority.
    const child = Bun.spawn(backgroundCommand(["sleep", "5"]));
    try {
      expect(priorityOf(child.pid)).toBe(31);
    } finally {
      child.kill();
    }
  });
});
