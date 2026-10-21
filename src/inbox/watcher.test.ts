import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { InboxSourceConfig, ServiceConfig } from "../config";
import { InboxWatcher } from "./watcher";

function makeConfig(
  sources: Record<string, InboxSourceConfig>,
  basePath: string
): ServiceConfig {
  return {
    server: { host: "127.0.0.1", port: 3001 },
    database: { path: ":memory:" },
    scheduler: { enabled: false, default_interval: "1h", stagger: false },
    sync: {},
    inbox: { watch_enabled: true, base_path: basePath, sources },
    media: { path: basePath },
    backup: {},
    llm: { providers: {} },
  };
}

describe("InboxWatcher.start", () => {
  let tmp: string;
  let watcher: InboxWatcher | null = null;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "inbox-watcher-test-"));
  });

  afterEach(async () => {
    watcher?.stop();
    watcher = null;
    await rm(tmp, { recursive: true, force: true });
  });

  it("throws when a source directory can't be created", async () => {
    // Force mkdir to fail for one source by pointing its directory *under* a
    // regular file, so mkdir(recursive) throws ENOTDIR.
    const blocker = join(tmp, "not-a-dir");
    await writeFile(blocker, "x");
    const badPath = join(blocker, "google");
    const config = makeConfig(
      {
        bad: { type: "local", local: badPath, parser: "noop" },
      },
      tmp
    );

    watcher = new InboxWatcher(config);
    await expect(watcher.start()).rejects.toThrow();
    expect(watcher.getWatchedDirectories()).not.toContain("bad");
  });

  it("cleans up already-watched sources when startup fails", async () => {
    const blocker = join(tmp, "not-a-dir");
    await writeFile(blocker, "x");
    const goodPath = join(tmp, "good");
    const badPath = join(blocker, "google");
    const config = makeConfig(
      {
        good: { type: "local", local: goodPath, parser: "noop" },
        bad: { type: "local", local: badPath, parser: "noop" },
      },
      tmp
    );

    watcher = new InboxWatcher(config);
    await expect(watcher.start()).rejects.toThrow();
    expect(watcher.getWatchedDirectories()).toHaveLength(0);
  });

  it("does not install a watcher when stopped while a watch attempt is in flight", async () => {
    // If stop() lands during stat()/mkdir(), watchSource must not install a
    // fresh FSWatcher into the now-empty map.
    const goodPath = join(tmp, "google");
    const sourceConfig: InboxSourceConfig = { type: "local", local: goodPath, parser: "noop" };
    const config = makeConfig({ google: sourceConfig }, tmp);

    watcher = new InboxWatcher(config);
    await watcher.start();
    expect(watcher.getWatchedDirectories()).toContain("google");

    // Calling watchSource runs it synchronously up to its first await (stat), so
    // the watcher is parked mid-attempt; stop() then runs before it resumes.
    const access = watcher as unknown as {
      watchSource(name: string, cfg: InboxSourceConfig): Promise<boolean>;
    };
    const inFlight = access.watchSource("google", sourceConfig);
    watcher.stop();

    await inFlight;
    expect(watcher.getWatchedDirectories()).toHaveLength(0);
  });
});
