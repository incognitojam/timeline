import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWritableDbAtPath } from "./connection";

let workDir: string | null = null;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

test("opening waits for another process's lock instead of failing", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-connection-test-"));
  const dbPath = join(workDir, "timeline.db");
  const setup = new Database(dbPath);
  setup.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x)");
  setup.close();

  // Holds an exclusive lock, reports it, then releases it shortly after. The
  // open below blocks this thread, so the release has to come from a timer.
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { Database } = require("bun:sqlite");
       const db = new Database(${JSON.stringify(dbPath)});
       db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO t VALUES (1)");
       console.log("held");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
    ],
    { stdout: "pipe" },
  );
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    reader.releaseLock();

    const db = openWritableDbAtPath(dbPath);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 1 });
    } finally {
      db.close();
    }
  } finally {
    holder.kill();
    await holder.exited;
  }
});
