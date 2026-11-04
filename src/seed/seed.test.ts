import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseDate } from "./context";
import { assertNotHostDataDir, assertReplaceableMedia, installBuild, SEED_MEDIA_MARKER } from "./install";

const SEED_ENTRY = resolve(import.meta.dir, "index.ts");
let workDirs: string[] = [];

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tl-seed-"));
  workDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  workDirs = [];
});

function runSeed(args: string[]) {
  const proc = Bun.spawnSync([process.execPath, "run", SEED_ENTRY, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(".seed-"));
}

describe("parseDate", () => {
  test("accepts real calendar dates", () => {
    expect(parseDate("2024-02-29").toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  test.each(["2026-02-30", "2026-13-01", "2026-1-5", "yesterday"])("rejects %s", (value) => {
    expect(() => parseDate(value)).toThrow("real calendar date");
  });
});

describe("assertNotHostDataDir", () => {
  test("refuses the host data directory, including through a symlink", () => {
    const root = workDir();
    const hostDir = join(root, "host");
    mkdirSync(hostDir);
    const hostDb = join(hostDir, "timeline.db");
    symlinkSync(hostDir, join(root, "alias"));

    expect(() => assertNotHostDataDir(hostDir, hostDb)).toThrow("Refusing to seed");
    expect(() => assertNotHostDataDir(join(root, "alias"), hostDb)).toThrow("Refusing to seed");
    expect(() => assertNotHostDataDir(root, hostDb)).not.toThrow();
  });
});

describe("assertReplaceableMedia", () => {
  test("refuses a media directory the seed did not create", () => {
    const out = workDir();
    mkdirSync(join(out, "media"));
    expect(() => assertReplaceableMedia(out)).toThrow("not created by the seed");
    writeFileSync(join(out, "media", SEED_MEDIA_MARKER), "");
    expect(() => assertReplaceableMedia(out)).not.toThrow();
  });
});

describe("installBuild", () => {
  function build(root: string, label: string): string {
    const dir = join(root, `build-${label}`);
    mkdirSync(join(dir, "media"), { recursive: true });
    writeFileSync(join(dir, "timeline.db"), `timeline ${label}`);
    writeFileSync(join(dir, "app-state.db"), `app-state ${label}`);
    writeFileSync(join(dir, "media", "photo.jpg"), `photo ${label}`);
    writeFileSync(join(dir, "media", SEED_MEDIA_MARKER), "");
    return dir;
  }

  test("replaces the previous seed and drops stale sidecars and embeddings", () => {
    const root = workDir();
    const out = join(root, "out");
    mkdirSync(out);
    installBuild(build(root, "old"), out);
    writeFileSync(join(out, "timeline.db-wal"), "stale wal");
    writeFileSync(join(out, "embeddings.db"), "stale vectors");

    installBuild(build(root, "new"), out);

    expect(readFileSync(join(out, "timeline.db"), "utf8")).toBe("timeline new");
    expect(readFileSync(join(out, "app-state.db"), "utf8")).toBe("app-state new");
    expect(readFileSync(join(out, "media", "photo.jpg"), "utf8")).toBe("photo new");
    expect(existsSync(join(out, "timeline.db-wal"))).toBe(false);
    expect(existsSync(join(out, "embeddings.db"))).toBe(false);
    expect(leftovers(out)).toEqual([]);
  });

  test("leaves the previous seed intact when staging the new one fails", () => {
    const root = workDir();
    const out = join(root, "out");
    mkdirSync(out);
    installBuild(build(root, "old"), out);
    const broken = build(root, "broken");
    rmSync(join(broken, "media"), { recursive: true });

    expect(() => installBuild(broken, out)).toThrow();

    expect(readFileSync(join(out, "timeline.db"), "utf8")).toBe("timeline old");
    expect(readFileSync(join(out, "app-state.db"), "utf8")).toBe("app-state old");
    expect(readFileSync(join(out, "media", "photo.jpg"), "utf8")).toBe("photo old");
    expect(leftovers(out)).toEqual([]);
  });
});

describe("bun run seed", () => {
  test("seeds a pinned anchor before every fixed-era generator's dates", () => {
    const out = workDir();
    const { code, output } = runSeed(["--only=thriva,trakt,swarm", "--anchor=2026-01-31", `--out=${out}`]);
    expect(output).toContain("Ready in");
    expect(code).toBe(0);

    const db = new Database(join(out, "timeline.db"), { readonly: true });
    const rows = db
      .query("SELECT source, COUNT(*) AS n, MAX(timestamp) AS newest FROM events GROUP BY source ORDER BY source")
      .all() as { source: string; n: number; newest: string }[];
    db.close();
    expect(rows.map((row) => row.source)).toEqual(["swarm", "thriva", "trakt"]);
    for (const row of rows) {
      expect(row.n).toBeGreaterThan(0);
      expect(row.newest < "2026-02-02").toBe(true);
    }
    expect(existsSync(join(out, "media", SEED_MEDIA_MARKER))).toBe(true);
    expect(leftovers(out)).toEqual([]);
  }, 60_000);

  test.each([
    [["--anchor=2026-02-30"], "real calendar date"],
    [["--only="], "--only needs at least one generator"],
    [["--only=no-such-source"], "Unknown generator"],
  ])("rejects %p before creating anything", (args, message) => {
    const out = workDir();
    const { code, output } = runSeed([...args, `--out=${out}`]);
    expect(code).not.toBe(0);
    expect(output).toContain(message);
    expect(readdirSync(out)).toEqual([]);
  }, 30_000);
});
