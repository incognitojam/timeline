import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { ServiceConfig } from "../config";
import { workerTestHooks } from "./worker";

function makeConfig(workDir: string, inboxPath: string): ServiceConfig {
  return {
    server: { host: "127.0.0.1", port: 3001 },
    database: { path: join(workDir, "timeline.db") },
    scheduler: { enabled: true, default_interval: "1h", stagger: false },
    sync: {
      backup: {
        enabled: true,
        interval: "1h",
        destination: join(workDir, "backups"),
      },
    },
    inbox: {
      watch_enabled: true,
      base_path: workDir,
      sources: {
        bad: { type: "local", local: inboxPath, parser: "noop" },
      },
    },
    media: { path: join(workDir, "media") },
    backup: {},
    llm: { providers: {} },
  };
}

describe("scheduler worker component startup", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "scheduler-worker-test-"));
  });

  afterEach(async () => {
    await workerTestHooks.stopComponents(1000);
    await rm(tmp, { recursive: true, force: true });
  });

  test("cleans up the scheduler if watcher startup fails", async () => {
    const blocker = join(tmp, "not-a-dir");
    await writeFile(blocker, "x");

    await expect(
      workerTestHooks.startComponents(makeConfig(tmp, join(blocker, "inbox")), false)
    ).rejects.toThrow();

    expect(workerTestHooks.getComponentState()).toEqual({
      schedulerRunning: false,
      watcherRunning: false,
      runnerRunning: false,
    });
  });
});
