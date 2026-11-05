import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "check-event-types.ts");
let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "check-event-types-"));
  dirs.push(dir);
  return dir;
}

function createDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE events (source TEXT, type TEXT, content TEXT)");
  db.run("CREATE TABLE identities (platform TEXT)");
  return db;
}

function addEvent(db: Database, source: string, type: string) {
  db.run("INSERT INTO events (source, type, content) VALUES (?, ?, 'private message body')", [source, type]);
}

function run(dbPath: string) {
  const proc = Bun.spawnSync([process.execPath, "run", SCRIPT, dbPath], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

describe("check-event-types", () => {
  test("passes a database with only declared types and known ids", () => {
    const path = join(workDir(), "timeline.db");
    const db = createDb(path);
    addEvent(db, "trakt", "trakt:movie");
    db.close();
    const { code, output } = run(path);
    expect(output).toContain("Undeclared event types: 0");
    expect(code).toBe(0);
  });

  test("reports undeclared types and unregistered ids without event content", () => {
    const dir = workDir();
    const path = join(dir, "timeline.db");
    const db = createDb(path);
    addEvent(db, "trakt", "trakt:unknown");
    addEvent(db, "retired-source", "retired:post");
    db.run("INSERT INTO identities (platform) VALUES ('retired-identity')");
    db.close();
    const appState = createDb(join(dir, "app-state.db"));
    appState.run("CREATE TABLE sync_log (source TEXT)");
    appState.run("CREATE TABLE sync_sources (source TEXT)");
    appState.run("INSERT INTO sync_log (source) VALUES ('retired-log')");
    appState.run("INSERT INTO sync_sources (source) VALUES ('retired-setting')");
    appState.close();

    const { code, output } = run(path);
    expect(code).toBe(1);
    expect(output).toContain("trakt trakt:unknown (1)");
    expect(output).toContain("retired-source retired:post (1)");
    expect(output).toContain("events.source: 1 (retired-source)");
    expect(output).toContain("identities.platform: 1 (retired-identity)");
    expect(output).toContain("sync_log.source: 1 (retired-log)");
    expect(output).toContain("sync_sources.source: 1 (retired-setting)");
    expect(output).not.toContain("private message body");
  });

  test("opens a WAL database with no -wal or -shm file and leaves it unchanged", () => {
    const path = join(workDir(), "timeline.db");
    const db = createDb(path);
    addEvent(db, "trakt", "trakt:movie");
    db.close();
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    const before = readFileSync(path);

    expect(run(path).code).toBe(0);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("reads committed WAL frames without checkpointing them into the database", () => {
    const dir = workDir();
    const live = join(dir, "live.db");
    const db = createDb(live);
    db.run("PRAGMA wal_autocheckpoint = 0");
    addEvent(db, "trakt", "trakt:unknown");
    // Copy while open, so the WAL still holds the frames, as a crash or clone would leave them.
    const path = join(dir, "timeline.db");
    copyFileSync(live, path);
    copyFileSync(`${live}-wal`, `${path}-wal`);
    db.close();
    const before = readFileSync(path);
    const walBefore = readFileSync(`${path}-wal`);

    const { code, output } = run(path);
    expect(output).toContain("trakt trakt:unknown (1)");
    expect(code).toBe(1);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(`${path}-wal`).equals(walBefore)).toBe(true);
  });
});
