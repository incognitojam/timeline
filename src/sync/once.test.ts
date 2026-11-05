import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getAppStateDb, getSyncState } from "../db/app-state";
import { getDb, initDb } from "../db/schema";
import { runSourceOnce, SourceRunError } from "./once";
import type { SyncSource } from "./types";

function claudeSession(dir: string, account: string): void {
  const projectDir = join(dir, "-tmp-demo");
  mkdirSync(projectDir, { recursive: true });
  const line = (uuid: string, role: "user" | "assistant", seconds: number, text: string) =>
    JSON.stringify({
      type: role,
      uuid: `${account}-${uuid}`,
      timestamp: `2026-04-01T00:00:${String(seconds).padStart(2, "0")}.000Z`,
      sessionId: `session-${account}`,
      cwd: "/tmp/demo",
      message: { role, content: role === "user" ? text : [{ type: "text", text }], model: "claude-sonnet-4-5" },
    });
  writeFileSync(
    join(projectDir, `session-${account}.jsonl`),
    `${[line("u1", "user", 1, "Hello"), line("a1", "assistant", 2, "Hi Alice")].join("\n")}\n`,
  );
}

describe("runSourceOnce", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-once-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("runs a registered source, records sync_log, and is idempotent on a second run", async () => {
    const account = `alice-${Date.now()}`;
    claudeSession(dir, account);
    const config = { path: dir, account };

    const first = await runSourceOnce("claude-code", { config });
    expect(first.cannotSync).toBeNull();
    expect(first.result).toMatchObject({ success: true, eventsAdded: 2 });
    expect(first.events.inserted.byType).toEqual({
      "claude-code:message:assistant": 1,
      "claude-code:message:user": 1,
    });
    expect(first.events.inserted.samples.map((sample) => sample.source_account)).toEqual([account, account]);
    expect(first.syncLog).toMatchObject({ source: "claude-code", success: 1, skipped: 0, events_added: 2 });

    const second = await runSourceOnce("claude-code", { config });
    expect(second.result).toMatchObject({ success: true, eventsAdded: 0 });
    expect(second.events.inserted.count).toBe(0);
    expect(second.syncLog?.id).toBeGreaterThan(first.syncLog?.id ?? Infinity);
  });

  it("reports a canSync refusal as a skipped sync_log row", async () => {
    const report = await runSourceOnce("claude-code", { config: { path: join(dir, "missing"), account: "alice" } });
    expect(report.cannotSync).toMatch(/not found/);
    expect(report.syncLog).toMatchObject({ success: 1, skipped: 1 });
  });

  it("rejects unknown sources and settings, and missing required settings, before writing", async () => {
    const appDb = getAppStateDb();
    appDb.prepare("DELETE FROM sync_sources WHERE source = 'claude-code'").run();

    await expect(runSourceOnce("no-such-source")).rejects.toThrow(SourceRunError);
    await expect(runSourceOnce("claude-code", { config: { path: dir, account: "a", extra: 1 } })).rejects.toThrow(
      'Unknown setting "extra"',
    );
    await expect(runSourceOnce("claude-code", { config: { account: "a" } })).rejects.toThrow(
      "Missing required setting(s) for claude-code: path",
    );
    await expect(runSourceOnce("embeddings", { config: { concurrency: 0 } })).rejects.toThrow("at least 1");
    expect(appDb.prepare("SELECT COUNT(*) AS n FROM sync_sources WHERE source = 'claude-code'").get()).toEqual({ n: 0 });
  });

  it("gives canSync the state on a dry run and does not call sync", async () => {
    let synced = false;
    const source: SyncSource = {
      name: "dry-run-probe",
      description: "test",
      enabled: true,
      canSync: async () =>
        getSyncState<{ cursor: number }>(getAppStateDb(), "dry-run-probe")?.cursor === 1 ? null : "state not seeded",
      sync: async () => {
        synced = true;
        throw new Error("sync must not run");
      },
    };
    const report = await runSourceOnce(source, { dryRun: true, state: { "dry-run-probe": { cursor: 1 } } });
    expect(report).toMatchObject({ dryRun: true, cannotSync: null, result: null });
    expect(synced).toBe(false);
  });

  it("seeds sync_state and reports inserted, updated, and deleted events", async () => {
    const db = getDb();
    initDb(db);
    const insert = db.prepare(
      "INSERT INTO events (source, source_id, type, timestamp, title, raw_data) VALUES ('probe', ?, 'probe:item', '2026-01-01T00:00:00Z', ?, '{}') RETURNING id",
    );
    const [kept, gap, edited, removed] = ["kept", "gap", "edited", "removed"].map(
      (id) => (insert.get(`${id}-${Date.now()}`, id) as { id: number }).id,
    );
    db.prepare("DELETE FROM events WHERE id = ?").run(gap);
    db.close();

    const schemaObjects = () => {
      const conn = getDb();
      const rows = conn.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
      conn.close();
      return rows;
    };
    const schemaBefore = schemaObjects();
    let schemaDuringRun: unknown;
    const source: SyncSource = {
      name: "change-probe",
      description: "test",
      enabled: true,
      canSync: async () => null,
      async sync() {
        schemaDuringRun = schemaObjects();
        const appDb = getAppStateDb();
        const cursor = getSyncState<{ cursor: number }>(appDb, "change-probe")?.cursor ?? 0;
        const conn = getDb();
        conn.prepare("UPDATE events SET title = 'edited twice' WHERE id = ?").run(edited);
        conn.prepare("UPDATE events SET title = 'edited thrice' WHERE id = ?").run(edited);
        conn.prepare("DELETE FROM events WHERE id = ?").run(removed);
        conn
          .prepare(
            "INSERT INTO events (source, source_id, type, title, raw_data) VALUES ('probe', ?, 'probe:new', 'new', '{}')",
          )
          .run(`new-${Date.now()}`);
        // An id below the highest existing one, as an explicit id can be.
        conn
          .prepare(
            "INSERT INTO events (id, source, source_id, type, title, raw_data) VALUES (?, 'probe', ?, 'probe:new', 'refilled', '{}')",
          )
          .run(gap, `refilled-${Date.now()}`);
        conn.close();
        appDb.prepare("INSERT OR REPLACE INTO sync_state (source, state) VALUES (?, ?)").run(
          "change-probe",
          JSON.stringify({ cursor: cursor + 1 }),
        );
        return { source: "change-probe", success: true, eventsAdded: 1, eventsUpdated: 1, durationMs: 0 };
      },
    };

    const report = await runSourceOnce(source, { state: { "change-probe": { cursor: 41 } } });
    expect(report.state["change-probe"]).toEqual({ cursor: 42 });
    expect(report.events.inserted).toMatchObject({ count: 2, byType: { "probe:new": 2 } });
    expect(report.events.inserted.samples.map((sample) => sample.id)).toContain(gap);
    expect(report.events.updated.count).toBe(1);
    expect(report.events.updated.samples).toEqual([expect.objectContaining({ id: edited, title: "edited thrice" })]);
    expect(report.events.deleted).toBe(1);
    expect(report.events.updated.samples.map((sample) => sample.id)).not.toContain(kept);

    // Tracking changes never touches the schema, so a killed run leaves nothing behind.
    expect(schemaDuringRun).toEqual(schemaBefore);
    expect(schemaObjects()).toEqual(schemaBefore);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("sync-once-snapshot-"))).toEqual([]);
  });
});

describe("sync:once CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sync-once-cli-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function cli(args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "once-cli.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it("gives the source only sandbox paths and explicit variables", async () => {
    // Bun loads .env from the working directory unless told not to.
    writeFileSync(join(dir, ".env"), "SYNC_ONCE_DOTENV_SECRET=leaked\n");
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "session.json"), "{}");
    const envDump = join(dir, "child-env.txt");
    const sidecar = join(dir, "fake-sidecar");
    writeFileSync(sidecar, `#!/bin/sh\nenv > "${envDump}"\ncat > /dev/null\n`);
    chmodSync(sidecar, 0o755);
    const sandbox = join(dir, "sandbox");

    const { stdout, exitCode } = await cli(
      [
        "google-messages",
        "--sandbox",
        sandbox,
        "--set",
        "account=alice",
        "--set",
        `binary=${sidecar}`,
        "--set",
        `state_dir=${stateDir}`,
        "--env",
        "EXPLICIT=1",
        "--json",
      ],
      { SYNC_ONCE_PARENT_SECRET: "leaked" },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ source: "google-messages", result: { success: true } });
    const childEnv = Object.fromEntries(
      readFileSync(envDump, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
    expect(childEnv.EXPLICIT).toBe("1");
    expect(childEnv.HOME).toBe(join(sandbox, "home"));
    expect(childEnv.TIMELINE_DB_PATH).toBe(join(sandbox, "timeline.db"));
    expect(childEnv.SYNC_ONCE_DOTENV_SECRET).toBeUndefined();
    expect(childEnv.SYNC_ONCE_PARENT_SECRET).toBeUndefined();
    expect(existsSync(join(sandbox, "app-state.db"))).toBe(true);
  });

  it("keeps .env from every Bun process a source starts, and resolves --set against the caller", async () => {
    writeFileSync(join(dir, ".env"), "SYNC_ONCE_DOTENV_SECRET=leaked\n");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const seen = join(dir, "descendant.txt");
    writeFileSync(
      join(bin, "rclone"),
      `#!/bin/sh\n"${process.execPath}" -p 'process.env.SYNC_ONCE_DOTENV_SECRET ?? "absent"' > "${seen}"\n`,
    );
    chmodSync(join(bin, "rclone"), 0o755);
    const config = join(dir, "config.toml");
    writeFileSync(config, `[inbox.sources.demo]\ntype = "rclone"\nremote = "demo:path"\nlocal = "demo"\n`);
    const { exitCode } = await cli([
      "inbox-rclone",
      "--sandbox",
      join(dir, "s"),
      "--config",
      config,
      "--env",
      `PATH=${bin}:${process.env.PATH}`,
    ]);
    expect(exitCode).toBe(0);
    expect(readFileSync(seen, "utf8").trim()).toBe("absent");

    const claude = join(dir, "sessions");
    mkdirSync(claude);
    const relative = await cli(["claude-code", "--sandbox", join(dir, "s2"), "--set", "path=sessions", "--set", "account=alice", "--json"]);
    expect(relative.exitCode).toBe(0);
    expect(JSON.parse(relative.stdout).config.path).toEndWith(join(basename(dir), "sessions"));
  });

  it("refuses config that sends inbox writes outside the sandbox", async () => {
    const outside = join(dir, "outside");
    for (const section of [`[inbox.sources.demo]\ntype = "rclone"\nremote = "demo:path"\nlocal = "${outside}"\n`, `[inbox.sources.demo]\ntype = "rclone"\nremote = "demo:path"\nlocal = "../../outside"\n`, `[inbox]\narchive_path = "${outside}"\n`]) {
      const config = join(dir, "config.toml");
      writeFileSync(config, section);
      const sandbox = join(dir, "s");
      const { stderr, exitCode } = await cli(["inbox-rclone", "--sandbox", sandbox, "--config", config]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("outside the sandbox");
      expect(existsSync(sandbox)).toBe(false);
      expect(existsSync(outside)).toBe(false);
    }
  });

  it("refuses a database sidecar linked into host data", async () => {
    const hostDir = join(process.env.HOME ?? "", ".local", "share", "timeline");
    mkdirSync(hostDir, { recursive: true });
    const hostFile = join(hostDir, "synthetic.bin");
    writeFileSync(hostFile, "synthetic");
    const scratch = join(dir, "scratch");
    mkdirSync(scratch);
    symlinkSync(hostFile, join(scratch, "embeddings.db-wal"));
    const sandbox = join(dir, "s");
    const { exitCode } = await cli(["render-sweep", "--dry-run", "--db", join(scratch, "timeline.db"), "--sandbox", sandbox]);
    expect(exitCode).toBe(2);
    expect(existsSync(sandbox)).toBe(false);
    rmSync(hostDir, { recursive: true, force: true });
  });

  it("dry-runs a symlinked database with the data committed to its WAL", async () => {
    const real = join(dir, "real.db");
    const writer = new Database(real);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE probe (id INTEGER);");
    writer.exec("INSERT INTO probe VALUES (1)");
    const link = join(dir, "link.db");
    symlinkSync(real, link);
    const sandbox = join(dir, "s");
    const before = readFileSync(real);
    const { exitCode } = await cli(["thumbhash", "--dry-run", "--db", link, "--sandbox", sandbox]);
    expect(exitCode).toBe(0);
    expect(readFileSync(real).equals(before)).toBe(true);
    writer.close();
    const copy = new Database(join(sandbox, "dry-run", "link.db"));
    expect(copy.prepare("SELECT COUNT(*) AS n FROM probe").get()).toEqual({ n: 1 });
    copy.close();
  });

  it("rejected requests create nothing beside --db and empty only what they filled", async () => {
    const db = join(dir, "new", "parent", "timeline.db");
    const owned = join(dir, "owned");
    mkdirSync(owned);
    const { exitCode } = await cli(["no-such-source", "--db", db, "--sandbox", owned]);
    expect(exitCode).toBe(2);
    expect(existsSync(join(dir, "new"))).toBe(false);
    expect(readdirSync(owned)).toEqual([]);

    const nested = await cli(["no-such-source", "--sandbox", join(dir, "a", "b", "c")]);
    expect(nested.exitCode).toBe(2);
    expect(existsSync(join(dir, "a"))).toBe(false);

    const asDir = await cli(["github", "--sandbox", join(dir, "s"), "--home-file", `x=${owned}`]);
    expect(asDir.exitCode).toBe(2);
    expect(asDir.stderr).toContain("is not a file");
    expect(existsSync(join(dir, "s"))).toBe(false);
  });

  it("refuses a database whose app-state.db sibling links into host data", async () => {
    const hostDir = join(process.env.HOME ?? "", ".local", "share", "timeline");
    mkdirSync(hostDir, { recursive: true });
    const hostState = join(hostDir, "app-state.db");
    writeFileSync(hostState, "synthetic host state");
    const scratch = join(dir, "scratch");
    mkdirSync(scratch);
    symlinkSync(hostState, join(scratch, "app-state.db"));

    const { stderr, exitCode } = await cli(["render-sweep", "--db", join(scratch, "timeline.db"), "--sandbox", join(dir, "s")]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("inside host data");
    expect(readFileSync(hostState, "utf8")).toBe("synthetic host state");
    rmSync(hostDir, { recursive: true, force: true });
  });

  it("dry-runs against copies, leaving --db untouched, with supplied state and fixture files", async () => {
    // thumbhash's canSync initialises the database it is given.
    const db = join(dir, "scratch", "timeline.db");
    const first = await cli(["thumbhash", "--dry-run", "--db", db, "--sandbox", join(dir, "s1"), "--json"]);
    expect(first.exitCode).toBe(0);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(join(dir, "scratch"))).toBe(false);

    const stateFile = join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ "example-key": { cursor: 7 } }));
    const fixture = join(dir, "github.json");
    writeFileSync(fixture, JSON.stringify({ token: "synthetic", username: "alice" }));
    const second = await cli([
      "github",
      "--dry-run",
      "--sandbox",
      join(dir, "s2"),
      "--state-json",
      stateFile,
      "--home-file",
      `.config/timeline/github.json=${fixture}`,
      "--json",
    ]);
    expect(JSON.parse(second.stdout)).toMatchObject({ cannotSync: null, state: { "example-key": { cursor: 7 } } });

    const escape = await cli(["github", "--sandbox", join(dir, "s3"), "--home-file", `../outside=${fixture}`]);
    expect(escape.exitCode).toBe(2);
  });

  it("copies --config into the sandbox without letting it move the database", async () => {
    const config = join(dir, "config.toml");
    writeFileSync(
      config,
      `[database]\npath = "${join(dir, "elsewhere.db")}"\n[embeddings]\nbase_url = "http://127.0.0.1:9/v1"\nmodel = "fake"\ndimensions = 3\n`,
    );
    const args = ["embeddings", "--dry-run", "--json"];
    const without = await cli([...args, "--sandbox", join(dir, "s1")]);
    expect(JSON.parse(without.stdout).cannotSync).toMatch(/not configured/);
    const withConfig = await cli([...args, "--sandbox", join(dir, "s2"), "--config", config]);
    expect(JSON.parse(withConfig.stdout).cannotSync).toBeNull();
    expect(existsSync(join(dir, "elsewhere.db"))).toBe(false);
  });

  it("exits 2 on a usage error and removes the sandbox it created", async () => {
    const sandbox = join(dir, "sandbox");
    const { stderr, exitCode } = await cli(["claude-code", "--sandbox", sandbox, "--set", "bogus=1"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Unknown setting "bogus" for claude-code');
    expect(readdirSync(dir)).not.toContain("sandbox");
  });
});
