import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyConnectionPragmas } from "../db/connection";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { REBUILD_SPACE, assertRehearsalCopy, rehearse, spaceCriteria } from "./rehearse-event-people-rebuild";
import { verifyEventPeople } from "./verify-event-people";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rehearsal-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("assertRehearsalCopy", () => {
  let host: string;
  let copy: string;

  beforeEach(() => {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "rehearsal"));
    host = join(root, "data", "timeline.db");
    writeFileSync(host, "host");
    writeFileSync(`${host}-wal`, "host wal");
    writeFileSync(`${host}-shm`, "host shm");
    copy = join(root, "rehearsal", "timeline.db");
  });

  test("accepts a separate copy", () => {
    copyFileSync(host, copy);
    copyFileSync(`${host}-wal`, `${copy}-wal`);
    expect(() => assertRehearsalCopy(copy, host)).not.toThrow();
  });

  test("refuses the host database and its directory", () => {
    expect(() => assertRehearsalCopy(host, host)).toThrow("Refusing");
    copyFileSync(host, join(root, "data", "copy.db"));
    expect(() => assertRehearsalCopy(join(root, "data", "copy.db"), host)).toThrow("Refusing");
  });

  test("refuses a symlink or hard link to the host database", () => {
    symlinkSync(host, copy);
    expect(() => assertRehearsalCopy(copy, host)).toThrow("Refusing");
    rmSync(copy);
    linkSync(host, copy);
    expect(() => assertRehearsalCopy(copy, host)).toThrow("Refusing");
  });

  test.each(["-wal", "-shm"])("refuses a copy whose %s is the host's, linked or symlinked", (suffix) => {
    copyFileSync(host, copy);
    linkSync(`${host}${suffix}`, `${copy}${suffix}`);
    expect(() => assertRehearsalCopy(copy, host)).toThrow("shares a file");
    rmSync(`${copy}${suffix}`);
    symlinkSync(`${host}${suffix}`, `${copy}${suffix}`);
    expect(() => assertRehearsalCopy(copy, host)).toThrow("symlink");
  });

  test("refuses a copy whose sidecar is symlinked anywhere, even to a missing file", () => {
    copyFileSync(host, copy);
    symlinkSync(join(root, "data", "missing-wal"), `${copy}-wal`);
    expect(() => assertRehearsalCopy(copy, host)).toThrow("symlink");
  });

  test("refuses a path with no database", () => {
    expect(() => assertRehearsalCopy(copy, host)).toThrow("No database");
  });
});

describe("rehearse", () => {
  let path: string;
  let lines: string[];
  const print = (line: string) => lines.push(line);
  const rows = () => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS count FROM event_people").get() as { count: number }).count;
    } finally {
      db.close();
    }
  };

  beforeEach(() => {
    lines = [];
    path = join(root, "timeline.db");
    const db = new Database(path);
    applyConnectionPragmas(db);
    initDb(db);
    const insert = db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
      VALUES ('discord', ?, 'alex', 'message:group', '2024-01-01T12:00:00Z', 'Group', ?, '{}', 'discord:group')
    `);
    for (let i = 0; i < 20; i++) insert.run(`m${i}`, JSON.stringify(["discord:a", "discord:b", "discord:c"]));
    // The members' rows, as the previous rule wrote them.
    db.exec(`INSERT INTO event_people (event_id, person, source, timestamp, is_sender)
      SELECT e.id, p.value, e.source, e.timestamp, 0 FROM events e, json_each(e.people) p WHERE p.key > 0`);
    db.close();
  });

  test("passes on a copy with rows from before the rule, and reports the steps", () => {
    const criteria = rehearse(path, { print });

    expect(criteria.filter((criterion) => !criterion.passed)).toEqual([]);
    expect(rows()).toBe(20);
    expect(lines.map((line) => JSON.parse(line).step)).toEqual([
      "copy", "verify before", "install this build's schema and triggers", "before", "rebuild", "verify after", "after", "checkpoint",
    ]);
  });

  test("stops before changing the copy when it has drift", () => {
    const db = new Database(path);
    db.exec("DELETE FROM event_people WHERE is_sender = 1 AND event_id = (SELECT MIN(id) FROM events)");
    db.close();

    const criteria = rehearse(path, { print });

    expect(criteria.at(-1)).toEqual({ name: "No drift before the rebuild", passed: false, detail: "1 discrepancies" });
    expect(rows()).toBe(59);
  });

  test("fails a copy with no events, where there is nothing to rehearse", () => {
    const db = new Database(path);
    db.exec("DELETE FROM events");
    db.close();

    expect(rehearse(path, { print })).toEqual([{ name: "The copy has events", passed: false, detail: "0 events" }]);
  });

  test("fails a copy already under the new rule, where the rebuild changes nothing", () => {
    expect(rehearse(path, { print }).every((criterion) => criterion.passed)).toBe(true);
    lines = [];

    const criteria = rehearse(path, { print });

    expect(criteria.find((criterion) => criterion.name === "The copy has member rows from before the rule to drop")?.passed).toBe(false);
  });

  describe("the script", () => {
    const script = resolve(import.meta.dir, "rehearse-event-people-rebuild.ts");
    const run = () => {
      const result = Bun.spawnSync([process.execPath, script, path], { env: { ...process.env, TIMELINE_DB_PATH: path } });
      return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
    };

    test("exits 0 when every criterion passes", () => {
      const { exitCode, output } = run();
      expect(output).toContain("REHEARSAL PASSED");
      expect(exitCode).toBe(0);
    });

    test("exits 1 when a criterion fails", () => {
      const db = new Database(path);
      db.exec("DELETE FROM event_people WHERE is_sender = 1 AND event_id = (SELECT MIN(id) FROM events)");
      db.close();

      const { exitCode, output } = run();
      expect(output).toContain("REHEARSAL FAILED");
      expect(exitCode).toBe(1);
    });
  });

  test("fails when member rows remain after the rebuild", () => {
    let calls = 0;
    const verify = (db: Database) => {
      const result = verifyEventPeople(db);
      return ++calls === 1 ? result : { ...result, rowsBeforeSenderRule: 1 };
    };

    const criteria = rehearse(path, { print, verify });

    expect(criteria.find((criterion) => criterion.name === "Verified clean after the rebuild")?.passed).toBe(false);
  });

  test("fails when verifying the rebuild throws", () => {
    let calls = 0;
    const verify = (db: Database) => {
      if (++calls === 2) throw new Error("verification interrupted");
      return verifyEventPeople(db);
    };

    const criteria = rehearse(path, { print, verify });

    expect(criteria.find((criterion) => criterion.name === "Verified clean after the rebuild")).toMatchObject({
      passed: false,
      detail: "verification failed: Error: verification interrupted",
    });
  });
});

describe("spaceCriteria", () => {
  const passed = (rows: number, walPeak: number) =>
    Object.fromEntries(spaceCriteria(rows, walPeak).map((criterion) => [criterion.name, criterion.passed]));

  test("passes the rehearsal measured on a 3.4-million-event copy", () => {
    expect(passed(3_397_044, 1.07e9)).toEqual({
      "WAL per new row within the estimate": true,
      "Peak space within the free-space floor": true,
    });
  });

  test("fails a WAL larger than the estimate, or a peak beyond the floor", () => {
    expect(passed(3_397_044, 1.5e9)["WAL per new row within the estimate"]).toBe(false);
    expect(passed(8_000_000, 3e9)).toEqual({
      "WAL per new row within the estimate": true,
      "Peak space within the free-space floor": false,
    });
  });

  test("states the figures the host guide gives", () => {
    const guide = readFileSync(resolve(import.meta.dir, "../../docs/user/macos-host.md"), "utf8").replace(/\s+/g, " ");
    const { floorBytes, walBytesPerRow, otherBytesPerRow } = REBUILD_SPACE;
    expect(guide).toContain(`at least ${floorBytes / 1e9} GB available`);
    expect(guide).toContain(`the ${floorBytes / 1e9} GB free-space floor`);
    expect(guide).toContain(`within ${walBytesPerRow} bytes per new row`);
    expect(guide).toContain(`plus ${otherBytesPerRow} bytes per new row`);
  });
});
