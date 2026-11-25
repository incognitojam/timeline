import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAppStateDbPath } from "./paths";
import { Database } from "./sqlite";

// getAppStateDb() caches one connection per process, and other test files in
// this process have already opened it, so the scenario runs in a fresh process.
const SCENARIO = `
  import { rmSync } from "node:fs";
  import { getAppStateDb } from "./src/db/app-state";
  import { getAppStateDbPath, getTimelineDbPath } from "./src/db/paths";
  const outcome = () => { try { getAppStateDb(); return "opened"; } catch { return "threw"; } };
  const first = outcome();
  const second = outcome();
  rmSync(getAppStateDbPath(getTimelineDbPath()));
  console.log(JSON.stringify([first, second, outcome()]));
`;

test("getAppStateDb sets up again after a failed first open instead of keeping the broken connection", () => {
  const timelineDbPath = join(mkdtempSync(join(tmpdir(), "app-state-open-")), "timeline.db");
  // A view where a table is expected makes setup fail partway.
  const blocker = new Database(getAppStateDbPath(timelineDbPath));
  blocker.exec("CREATE VIEW upload_tokens AS SELECT 1 AS label");
  blocker.close();

  const proc = Bun.spawnSync([process.execPath, "--no-env-file", "-e", SCENARIO], {
    cwd: join(import.meta.dir, "../.."),
    env: { ...process.env, TIMELINE_DB_PATH: timelineDbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.stderr.toString()).toBe("");
  // Before, the second call returned the cached handle whose setup had failed.
  expect(JSON.parse(proc.stdout.toString())).toEqual(["threw", "threw", "opened"]);
});
