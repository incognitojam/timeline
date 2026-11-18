import { expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parserCliArgs } from "./cli";

const parsers = [
  "amp", "claude-code", "codex", "conductor", "opencode", "t3code",
  "claude", "wakatime", "monzo",
  "spotify", "reddit", "amex", "linkedin", "google/location",
];

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "parser-cli-"));
  const home = join(root, "home");
  const media = join(root, "media");
  const logs = join(root, "logs");
  for (const dir of [home, media, logs]) mkdirSync(dir);
  const db = join(root, "timeline.db");
  return {
    root, logs, db, media,
    env: {
      ...process.env, HOME: home, TIMELINE_DB_PATH: db, TIMELINE_MEDIA_PATH: media,
      // Keep Bun's own transpilation cache out of the HOME write assertion.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
  };
}
function run(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, resolve(`src/platforms/${name}/parser.ts`), ...args],
    env, stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
for (const name of parsers) {
  test(`${name}: help never opens storage`, () => {
    const box = sandbox();
    const result = run(name, ["--help"], box.env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(existsSync(box.db)).toBe(false);
    expect(readdirSync(box.media)).toEqual([]);
    expect(readdirSync(join(box.root, "home"))).toEqual([]);
    expect(readdirSync(box.root).sort()).toEqual(["home", "logs", "media"]);
  });
  test(`${name}: rejects flags after positional arguments`, () => {
    const box = sandbox();
    const result = run(name, [box.logs, "alice", "--dryrun"], box.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown option: --dryrun");
    expect(existsSync(box.db)).toBe(false);
    expect(readdirSync(box.media)).toEqual([]);
    expect(readdirSync(join(box.root, "home"))).toEqual([]);
  });
}
test("keeps defaults and valid argument ordering", () => {
  expect(parserCliArgs({ usage: "test" }, [])).toEqual([]);
  for (const args of [
    ["./logs", "alice", "--refresh-raw-data"],
    ["--refresh-raw-data", "./logs", "alice"],
    ["--dry-run"],
    ["alice", "./input.db", "--dry-run"],
  ]) {
    expect(parserCliArgs({ usage: "test", flags: ["--dry-run", "--refresh-raw-data"] }, args)).toEqual(args);
  }
});
test("shared wrapper imports synthetic Spotify data with requested account", () => {
  const box = sandbox();
  mkdirSync(join(box.logs, "Spotify Extended Streaming History"));
  writeFileSync(
    join(box.logs, "Spotify Extended Streaming History", "Streaming_History_Audio.json"),
    JSON.stringify([{
      ts: "2026-01-01T12:00:00Z", ms_played: 60000, platform: "Linux",
      master_metadata_track_name: "Synthetic track",
      master_metadata_album_artist_name: "Example artist",
      master_metadata_album_album_name: "Example album",
      spotify_track_uri: "spotify:track:synthetic",
    }]),
  );
  const result = run("spotify", [box.logs, "alice"], box.env);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const db = new Database(box.db, { readonly: true });
  try {
    expect(db.query("SELECT source_account FROM events WHERE source = 'spotify'").all())
      .toEqual([{ source_account: "alice" }]);
  } finally {
    db.close();
  }
});
for (const name of ["amp", "claude-code", "opencode"]) {
  test(`${name}: explicit empty logs and account still import`, () => {
    const box = sandbox();
    if (name === "opencode") mkdirSync(join(box.logs, "storage", "session"), { recursive: true });
    const result = run(name, [box.logs, "alice", "--refresh-raw-data"], box.env);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Account: alice");
    expect(existsSync(box.db)).toBe(true);
  });
}
test("Codex dry run preserves arguments without creating storage", () => {
  const box = sandbox();
  const result = run("codex", ["--dry-run", box.logs, "alice", "--refresh-raw-data"], box.env);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Account: alice");
  expect(existsSync(box.db)).toBe(false);
});

test("conductor: valid dry run preserves account and input path", () => {
  const box = sandbox();
  const input = join(box.logs, "input.sqlite");
  const source = new Database(input);
  source.exec(`CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, default_branch TEXT, created_at TEXT);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT, state TEXT, created_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, status TEXT, agent_type TEXT, model TEXT, created_at TEXT);
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, model TEXT,
        sent_at TEXT, created_at TEXT, turn_id TEXT, cancelled_at TEXT
      );
    INSERT INTO workspaces (id, branch) VALUES ('workspace-1', 'alice/example');`);
  source.close();
  const result = run("conductor", [input, "--dry-run", "--refresh-raw-data"], box.env);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Account: alice");
  expect(existsSync(box.db)).toBe(false);
});

test("t3code: valid dry run preserves account and input path", () => {
  const box = sandbox();
  const input = join(box.logs, "input.sqlite");
  const source = new Database(input);
  source.exec(`CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, created_at TEXT);
      CREATE TABLE projection_threads (
        thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT, worktree_path TEXT,
        model_selection_json TEXT, created_at TEXT, archived_at TEXT, deleted_at TEXT
      );
      CREATE TABLE projection_thread_sessions (thread_id TEXT PRIMARY KEY, provider_name TEXT, status TEXT);
      CREATE TABLE projection_thread_messages (
        message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL,
        is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL, attachments_json TEXT
      );
      CREATE TABLE projection_thread_activities (
        activity_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, tone TEXT NOT NULL, kind TEXT NOT NULL,
        summary TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, sequence INTEGER
      );
    `);
  source.close();
  const result = run("t3code", ["alice", input, "--dry-run", "--refresh-raw-data"], box.env);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Account: alice");
  expect(existsSync(box.db)).toBe(false);
});


test("Codex retains its default directory and default account", () => {
  const box = sandbox();
  const logs = join(box.env.HOME, ".codex", "sessions");
  mkdirSync(logs, { recursive: true });
  const result = run("codex", ["--dry-run"], box.env);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(logs);
  expect(result.stdout).toContain("Account: default");
  expect(existsSync(box.db)).toBe(false);
});

for (const name of ["t3code", "spotify", "claude"]) {
  test(`${name}: missing required arguments still fail without storage`, () => {
    const box = sandbox();
    const result = run(name, [], box.env);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain("Usage:");
    expect(existsSync(box.db)).toBe(false);
  });
}

test("WakaTime keeps its export, account, and heartbeat option", () => {
  const box = sandbox();
  const input = join(box.logs, "export.json");
  writeFileSync(input, JSON.stringify({ user: {}, range: { start: 0, end: 1 }, days: [] }));
  const result = run("wakatime", ["--include-heartbeats", input, "alice"], box.env);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("wakatime-alice-");
});

test("Monzo status accepts its headless option without syncing", () => {
  const box = sandbox();
  const result = run("monzo", ["status", "--headless"], box.env);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Not configured.");
  expect(existsSync(box.db)).toBe(false);
});


test("help aliases, unknown options, and missing arguments exit before import", () => {
  const exit = spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit:${code}`); });
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const args of [["--help"], ["-h"], ["./logs", "alice", "-h"]]) {
      expect(() => parserCliArgs({ usage: "test", minArgs: 1 }, args)).toThrow("exit:0");
    }
    for (const args of [["--dryrun"], ["-x"], ["./logs", "--dryrun"], ["--help", "--dryrun"]]) {
      expect(() => parserCliArgs({ usage: "test" }, args)).toThrow("exit:1");
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining("Unknown option:"));
    }
    const options = { usage: "test", flags: ["--dry-run"], minArgs: 1, details: "Examples:\n  test ./logs" };
    log.mockClear();
    expect(() => parserCliArgs(options, ["--help"])).toThrow("exit:0");
    const helpText = log.mock.calls.map((call) => call[0]);
    log.mockClear();
    expect(() => parserCliArgs(options, ["--dry-run"])).toThrow("exit:1");
    expect(log.mock.calls.map((call) => call[0])).toEqual(helpText);
  } finally {
    exit.mockRestore();
    log.mockRestore();
    error.mockRestore();
  }
});
