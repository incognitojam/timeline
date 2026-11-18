import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/sqlite";
import { backupDatabase } from "./backup";

const TIMELINE_DB_PATH = process.env.TIMELINE_DB_PATH!;

let backupDir: string;

beforeAll(() => {
  backupDir = join(tmpdir(), `backup-test-${Date.now()}`);
  mkdirSync(backupDir, { recursive: true });

  // Ensure timeline.db has tables (VACUUM INTO needs a valid DB)
  const db = new Database(TIMELINE_DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY)");
  db.close();
});

afterAll(() => {
  rmSync(backupDir, { recursive: true, force: true });
});

describe("backupDatabase", () => {

  test("backs up a database", async () => {
    const result = await backupDatabase({
      dbPath: TIMELINE_DB_PATH,
      destination: backupDir,
      prefix: "timeline",
      keepCount: 24,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.backupPath).toBeString();
    expect(result.backupPath).toMatch(/timeline-.*\.db$/);
    expect(result.sizeMB).toBeNumber();

    const files = readdirSync(backupDir);
    expect(files.some((f) => f.startsWith("timeline-") && f.endsWith(".db"))).toBe(true);
  });

  test("fails when source database is missing", async () => {
    const freshDir = join(backupDir, "missing-db");
    mkdirSync(freshDir, { recursive: true });

    const result = await backupDatabase({
      dbPath: "/nonexistent/path/timeline.db",
      destination: freshDir,
      prefix: "timeline",
      keepCount: 24,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Database not found");

    rmSync(freshDir, { recursive: true, force: true });
  });

  test("cleans up old backups beyond keepCount", async () => {
    const cleanDir = join(backupDir, "cleanup-test");
    mkdirSync(cleanDir, { recursive: true });

    // Create fake old backups, dated by mtime as cleanup orders them
    for (let i = 0; i < 5; i++) {
      const path = join(cleanDir, `timeline-2020-01-0${i + 1}T00-00-00.db`);
      writeFileSync(path, "");
      const mtime = new Date(`2020-01-0${i + 1}T00:00:00Z`);
      utimesSync(path, mtime, mtime);
    }

    const result = await backupDatabase({
      dbPath: TIMELINE_DB_PATH,
      destination: cleanDir,
      prefix: "timeline",
      keepCount: 2,
    });

    expect(result.success).toBe(true);
    // keepCount=2: 5 old + 1 new = 6, keep the 2 newest → 4 deleted
    expect(result.deleted).toBe(4);
    expect(result.backupPath).toBeString();

    const remaining = readdirSync(cleanDir).filter((f) => f.startsWith("timeline-") && f.endsWith(".db"));
    expect(remaining.sort()).toEqual(["timeline-2020-01-05T00-00-00.db", basename(result.backupPath ?? "")].sort());

    rmSync(cleanDir, { recursive: true, force: true });
  });
});
