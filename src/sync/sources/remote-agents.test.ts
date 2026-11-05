import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { getAppStateDb, setSyncState } from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
import {
  generateKey,
  isHostTrusted,
  KeyExistsError,
  knownHostsName,
  mirrorDir,
  parseRemoteHost,
  pullTarget,
  readPublicKey,
  remoteAgentsPaths,
  type RemoteAgentsPaths,
} from "../remote-agents";
import type { SyncOptions } from "../types";
import { parseRemoteAgentsConfig, REMOTE_AGENTS_SOURCE, syncRemoteAgents } from "./remote-agents";

const WRAPPER = resolve(import.meta.dir, "../../../tools/timeline-export/timeline-export");
/** timeline-export serves pulls with rsync inside a bubblewrap sandbox; skip pulls where that cannot run. */
const canServePulls =
  Bun.which("rsync") !== null &&
  Bun.which("bwrap") !== null &&
  Bun.spawnSync(["bwrap", "--unshare-all", "--ro-bind", "/", "/", "true"]).exitCode === 0;
// CI provisions both, so a skip there would silently drop the confinement tests.
if (process.env.TIMELINE_REQUIRE_PULL_TESTS === "1" && !canServePulls) {
  throw new Error("TIMELINE_REQUIRE_PULL_TESTS=1 but rsync and a working bubblewrap sandbox are not available");
}

function jsonl(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function claudeLine(uuid: string, text: string) {
  return {
    type: "user",
    uuid,
    timestamp: "2026-04-01T00:00:00.000Z",
    sessionId: "remote-session-1",
    cwd: "/tmp/project",
    message: { role: "user", content: text },
  };
}

function codexSession(id: string) {
  return [
    {
      timestamp: "2026-06-10T10:00:00.000Z",
      type: "session_meta",
      payload: { id, timestamp: "2026-06-10T10:00:00.000Z", cwd: "/tmp/project", originator: "codex_cli_rs", source: "cli" },
    },
    {
      timestamp: "2026-06-10T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "fix the bug", images: [], local_images: [] },
    },
    {
      timestamp: "2026-06-10T10:00:30.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Fixed the bug", phase: "final_answer", memory_citation: null },
    },
  ];
}

describe("remote-agents sync", () => {
  // Migrating the fresh test database takes seconds; keep that out of the per-test timeout.
  beforeAll(() => {
    const db = getDb();
    initDb(db);
    db.close();
  }, 30_000);
  let root: string;
  let remoteHome: string;
  let paths: RemoteAgentsPaths;
  let account: string;
  let fakeSsh: string;

  /** Stand-in for ssh: skips options and the host, then runs the forced command locally like sshd. */
  function writeFakeSsh(path: string, body: string) {
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function options(settings: Record<string, unknown> = {}): SyncOptions {
    return {
      verbose: false,
      config: {
        sources: {
          [REMOTE_AGENTS_SOURCE]: { ssh_target: "alice@agent-host", account, ...settings },
        },
      },
    };
  }

  function countEvents(): Record<string, number> {
    const rows = getDb()
      .prepare("SELECT source, COUNT(*) AS n FROM events WHERE source_account = ? GROUP BY source")
      .all(account) as Array<{ source: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.source, row.n]));
  }

  beforeEach(() => {
    root = join(tmpdir(), `remote-agents-${randomUUID()}`);
    remoteHome = join(root, "remote-home");
    paths = remoteAgentsPaths(join(root, "timeline"));
    account = `alice@agent-host-${randomUUID().slice(0, 8)}`;
    mkdirSync(join(remoteHome, ".claude/projects/-tmp-project"), { recursive: true });
    mkdirSync(join(remoteHome, ".codex/sessions/2026/06/10"), { recursive: true });
    writeFileSync(
      join(remoteHome, ".claude/projects/-tmp-project/remote-session-1.jsonl"),
      jsonl([claudeLine(randomUUID(), "hello from the remote host")]),
    );
    writeFileSync(
      join(remoteHome, ".codex/sessions/2026/06/10/rollout-2026-06-10T10-00-00-remote.jsonl"),
      jsonl(codexSession(`codex-${randomUUID()}`)),
    );
    fakeSsh = writeFakeSsh(
      join(root, "fake-ssh"),
      [
        'while [[ $# -gt 0 ]]; do case "$1" in -o|-i|-p|-F|-l) shift 2;; -*) shift;; *) shift; break;; esac; done',
        `HOME=${remoteHome} SSH_ORIGINAL_COMMAND="$*" exec ${WRAPPER}`,
      ].join("\n"),
    );
    getAppStateDb().prepare("DELETE FROM sync_state WHERE source = ?").run(REMOTE_AGENTS_SOURCE);
    // The stand-in ssh ignores keys, so placeholder key files and a pinned host suffice.
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.privateKey, "placeholder");
    writeFileSync(paths.publicKey, "ssh-ed25519 AAAAexample timeline@test\n");
    writeFileSync(paths.knownHosts, "agent-host ssh-ed25519 AAAAexample\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fails without a key or a trusted host key instead of skipping", async () => {
    rmSync(paths.knownHosts);
    const untrusted = await syncRemoteAgents(options(), { paths, sshCommand: fakeSsh });
    expect(untrusted.success).toBe(false);
    expect(untrusted.error).toContain("Host key for alice@agent-host is not trusted yet");

    rmSync(paths.privateKey);
    const keyless = await syncRemoteAgents(options(), { paths, sshCommand: fakeSsh });
    expect(keyless.success).toBe(false);
    expect(keyless.error).toContain("No SSH key yet");
  });

  it.skipIf(!canServePulls)("mirrors both targets, imports them under the account, and re-runs idempotently", async () => {
    const first = await syncRemoteAgents(options(), { paths, sshCommand: fakeSsh });
    expect(first.error).toBeUndefined();
    expect(first.success).toBe(true);
    expect(countEvents()).toEqual({ "claude-code": 1, codex: 2 });
    expect(first.eventsAdded).toBe(3);
    expect(first.metadata?.targets).toEqual([
      expect.objectContaining({ target: "claude-code", eventsAdded: 1, files: 1 }),
      expect.objectContaining({ target: "codex", eventsAdded: 2, files: 1 }),
    ]);

    const again = await syncRemoteAgents(options(), { paths, sshCommand: fakeSsh });
    expect(again.success).toBe(true);
    expect(again.eventsAdded).toBe(0);

    appendFileSync(
      join(remoteHome, ".claude/projects/-tmp-project/remote-session-1.jsonl"),
      jsonl([claudeLine(randomUUID(), "a later message")]),
    );
    const appended = await syncRemoteAgents(options({ targets: ["claude-code"] }), { paths, sshCommand: fakeSsh });
    expect(appended.eventsAdded).toBe(1);
    expect(countEvents()).toEqual({ "claude-code": 2, codex: 2 });
  });

  it.skipIf(!canServePulls)("pulls when Timeline's data directory contains a space", async () => {
    const spaced = remoteAgentsPaths(join(root, "Application Support", "timeline"));
    mkdirSync(spaced.dir, { recursive: true });
    writeFileSync(spaced.privateKey, "placeholder");
    writeFileSync(spaced.publicKey, "ssh-ed25519 AAAAexample timeline@test\n");
    writeFileSync(spaced.knownHosts, "agent-host ssh-ed25519 AAAAexample\n");
    // Real ssh splits this option on spaces, so it must reach ssh without any.
    const strictSsh = writeFakeSsh(
      join(root, "strict-ssh"),
      [
        'for arg in "$@"; do',
        '  [[ $arg == UserKnownHostsFile=* ]] || continue',
        '  file=${arg#*=}',
        '  [[ $file != *" "* && -f $file ]] || { echo "bad known_hosts: $file" >&2; exit 1; }',
        "done",
        `exec ${fakeSsh} "$@"`,
      ].join("\n"),
    );
    const result = await syncRemoteAgents(options({ targets: ["codex"] }), { paths: spaced, sshCommand: strictSsh });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it.skipIf(!canServePulls)("removes mirrored files the remote host deleted", async () => {
    await syncRemoteAgents(options({ targets: ["codex"] }), { paths, sshCommand: fakeSsh });
    const host = parseRemoteHost("alice@agent-host", 22);
    const mirrored = join(mirrorDir(paths, host, "codex"), "2026/06/10/rollout-2026-06-10T10-00-00-remote.jsonl");
    expect(existsSync(mirrored)).toBe(true);

    rmSync(join(remoteHome, ".codex/sessions/2026/06/10/rollout-2026-06-10T10-00-00-remote.jsonl"));
    const result = await syncRemoteAgents(options({ targets: ["codex"] }), { paths, sshCommand: fakeSsh });
    expect(result.success).toBe(true);
    expect(existsSync(mirrored)).toBe(false);
  });

  it.skipIf(!canServePulls)("fails when the remote host lacks a requested target", async () => {
    rmSync(join(remoteHome, ".codex"), { recursive: true });
    const result = await syncRemoteAgents(options(), { paths, sshCommand: fakeSsh });
    expect(result.success).toBe(false);
    expect(result.error).toContain("codex:");
    expect(result.error).toContain(".codex/sessions not found");
  });

  describe("unreachable host", () => {
    let unreachable: string;
    const now = new Date("2026-10-22T12:00:00Z");

    beforeEach(() => {
      unreachable = writeFakeSsh(
        join(root, "unreachable-ssh"),
        'echo "ssh: connect to host agent-host port 22: Connection timed out" >&2; exit 255',
      );
    });

    function pulledHoursAgo(hours: number) {
      setSyncState(getAppStateDb(), REMOTE_AGENTS_SOURCE, {
        host: "alice@agent-host",
        lastPullAt: new Date(now.getTime() - hours * 3_600_000).toISOString(),
      });
    }

    it("is skipped while the last successful pull is within the staleness limit", async () => {
      pulledHoursAgo(3);
      const result = await syncRemoteAgents(options(), { paths, sshCommand: unreachable, now: () => now });
      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.metadata?.skipReason).toBe("alice@agent-host unreachable; last successful pull 3h ago");
    });

    it.skipIf(!canServePulls)("treats a host lost between the probe and the pull the same way", async () => {
      const lostAfterProbe = writeFakeSsh(
        join(root, "lost-after-probe-ssh"),
        [
          'if [[ ${*: -1} == "timeline-export probe" ]]; then exec ' + fakeSsh + ' "$@"; fi',
          'echo "ssh: connect to host agent-host port 22: Connection timed out" >&2',
          "exit 255",
        ].join("\n"),
      );
      pulledHoursAgo(3);
      const deferred = await syncRemoteAgents(options(), { paths, sshCommand: lostAfterProbe, now: () => now });
      expect(deferred.success).toBe(true);
      expect(deferred.skipped).toBe(true);
      expect(deferred.metadata?.skipReason).toBe("alice@agent-host unreachable; last successful pull 3h ago");

      pulledHoursAgo(30);
      const stale = await syncRemoteAgents(options(), { paths, sshCommand: lostAfterProbe, now: () => now });
      expect(stale.success).toBe(false);
      expect(stale.error).toContain("last successful pull 30h ago exceeds 24h");
    });

    it("fails once the last successful pull is older than the limit", async () => {
      pulledHoursAgo(30);
      const result = await syncRemoteAgents(options(), { paths, sshCommand: unreachable, now: () => now });
      expect(result.success).toBe(false);
      expect(result.skipped).toBeUndefined();
      expect(result.error).toContain("last successful pull 30h ago exceeds 24h");
    });

    it("honours a configured staleness limit", async () => {
      pulledHoursAgo(3);
      const result = await syncRemoteAgents(options({ max_staleness_hours: 2 }), {
        paths,
        sshCommand: unreachable,
        now: () => now,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("exceeds 2h");
    });

    it("fails when it has never pulled from this host", async () => {
      setSyncState(getAppStateDb(), REMOTE_AGENTS_SOURCE, {
        host: "someone@other-host",
        lastPullAt: now.toISOString(),
      });
      const result = await syncRemoteAgents(options(), { paths, sshCommand: unreachable, now: () => now });
      expect(result.success).toBe(false);
      expect(result.error).toContain("no successful pull yet");
    });
  });

  it("fails immediately when the host refuses the key, even after a recent pull", async () => {
    setSyncState(getAppStateDb(), REMOTE_AGENTS_SOURCE, {
      host: "alice@agent-host",
      lastPullAt: new Date().toISOString(),
    });
    const refused = writeFakeSsh(join(root, "refused-ssh"), 'echo "alice@agent-host: Permission denied (publickey)." >&2; exit 255');
    const result = await syncRemoteAgents(options(), { paths, sshCommand: refused });
    expect(result.success).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toContain("Permission denied");
  });

  it("fails with a pointer to Test connection when the host key changed", async () => {
    const mismatched = writeFakeSsh(
      join(root, "mismatched-ssh"),
      'echo "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@" >&2; echo "Host key verification failed." >&2; exit 255',
    );
    const result = await syncRemoteAgents(options(), { paths, sshCommand: mismatched });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Host key for alice@agent-host does not match the trusted key");
    expect(result.error).toContain("Test connection");
  });

  it("fails when the remote end is not timeline-export", async () => {
    const plainShell = writeFakeSsh(join(root, "plain-ssh"), 'echo "Welcome to agent-host"');
    const result = await syncRemoteAgents(options(), { paths, sshCommand: plainShell });
    expect(result.success).toBe(false);
    expect(result.error).toContain("did not answer as timeline-export protocol 1");
  });
});

describe("parseRemoteAgentsConfig", () => {
  it("applies defaults", () => {
    const config = parseRemoteAgentsConfig({ ssh_target: "alice@agent-host", account: "alice@agent-host" });
    expect(config.host).toEqual({ target: "alice@agent-host", host: "agent-host", port: 22 });
    expect(config.targets).toEqual(["claude-code", "codex"]);
    expect(config.maxStalenessHours).toBe(24);
  });

  it("rejects missing fields, unknown targets, and option-like hosts", () => {
    expect(() => parseRemoteAgentsConfig({ account: "a" })).toThrow("Missing 'ssh_target'");
    expect(() => parseRemoteAgentsConfig({ ssh_target: "agent-host" })).toThrow("Missing 'account'");
    expect(() =>
      parseRemoteAgentsConfig({ ssh_target: "agent-host", account: "a", targets: ["claude-code", "styal"] })
    ).toThrow("Unknown remote-agents targets: styal");
    expect(() => parseRemoteAgentsConfig({ ssh_target: "-oProxyCommand=evil", account: "a" })).toThrow(
      "Invalid SSH target",
    );
  });
});

describe("SSH key and host trust", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `remote-agents-key-${randomUUID()}`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(Bun.which("ssh-keygen") === null)("generates a key once and rotates it only when asked", async () => {
    const paths = remoteAgentsPaths(dir);
    expect(readPublicKey(paths)).toBeNull();
    const first = await generateKey(paths, { replace: false });
    expect(first).toStartWith("ssh-ed25519 ");
    await expect(generateKey(paths, { replace: false })).rejects.toThrow("already exists");
    const rotated = await generateKey(paths, { replace: true });
    expect(rotated).not.toBe(first);
    expect(readPublicKey(paths)).toBe(rotated);
  });

  it.skipIf(Bun.which("ssh-keygen") === null)("lets only one of two concurrent requests create the key", async () => {
    const paths = remoteAgentsPaths(dir);
    const results = await Promise.allSettled([
      generateKey(paths, { replace: false }),
      generateKey(paths, { replace: false }),
    ]);
    const created = results.filter((result) => result.status === "fulfilled");
    expect(created).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", reason: expect.any(KeyExistsError) },
    ]);
    expect(readPublicKey(paths)).toBe((created[0] as PromiseFulfilledResult<string>).value);
  });

  it("matches pinned hosts by name and port", () => {
    const paths = remoteAgentsPaths(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(paths.knownHosts, "agent-host ssh-ed25519 AAAAexample\n[other-host]:2222 ssh-ed25519 AAAAexample\n");
    expect(isHostTrusted(paths, parseRemoteHost("alice@agent-host", 22))).toBe(true);
    expect(isHostTrusted(paths, parseRemoteHost("alice@agent-host", 2222))).toBe(false);
    expect(isHostTrusted(paths, parseRemoteHost("other-host", 2222))).toBe(true);
    expect(knownHostsName(parseRemoteHost("other-host", 2222))).toBe("[other-host]:2222");
  });
});

describe("timeline-export wrapper", () => {
  let home: string;

  beforeEach(() => {
    home = join(tmpdir(), `timeline-export-${randomUUID()}`);
    mkdirSync(join(home, ".codex/sessions"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function runWrapper(command: string) {
    // stdin is closed, so an accepted rsync server stops at the protocol handshake.
    return Bun.spawnSync([WRAPPER], { env: { PATH: process.env.PATH, HOME: home, SSH_ORIGINAL_COMMAND: command }, stdin: "ignore" });
  }

  it("refuses anything but a probe or an allow-listed rsync", () => {
    expect(runWrapper("cat ~/.ssh/id_ed25519").stderr.toString()).toContain("refused command");
    expect(runWrapper("timeline-export rsync ../.ssh --server --sender -r . ./").stderr.toString()).toContain(
      "unknown target",
    );
  });

  it.skipIf(!canServePulls)("accepts macOS openrsync's server arguments", () => {
    const openrsync = runWrapper("timeline-export rsync codex --server --sender --delete-before -r -t --dirs . ./");
    expect(openrsync.stderr.toString()).not.toContain("timeline-export:");
    const upload = runWrapper("timeline-export rsync codex --server -r -t . ./");
    expect(upload.stderr.toString()).toContain("only read-only pulls are allowed");
  });

  it("refuses rsync options and paths that could read outside the target", () => {
    const escapes = [
      ["--server --sender --copy-unsafe-links -tre.iLsfxCIvu . ./", "refused rsync option: --copy-unsafe-links"],
      ["--server --sender -Ltre.iLsfxCIvu . ./", "refused rsync option: -Ltre.iLsfxCIvu"],
      ["--server --sender -tre.iLsfxCIvu . ./../.ssh", "refused rsync path: ./../.ssh"],
      ["--server --sender -tre.iLsfxCIvu . *", "refused rsync path: *"],
    ];
    for (const [args, message] of escapes) {
      expect(runWrapper(`timeline-export rsync codex ${args}`).stderr.toString()).toContain(message);
    }
  });

  it.skipIf(!canServePulls)("does not let a symlink in the target expose files outside it", async () => {
    const outside = join(home, "outside.txt");
    writeFileSync(outside, "synthetic file outside the target");
    symlinkSync(outside, join(home, ".codex/sessions/link"));
    const dest = join(home, "dest");
    const fakeSsh = join(home, "fake-ssh");
    writeFileSync(
      fakeSsh,
      [
        "#!/usr/bin/env bash",
        'while [[ $# -gt 0 ]]; do case "$1" in -o|-i|-p|-F|-l) shift 2;; -*) shift;; *) shift; break;; esac; done',
        `HOME=${home} SSH_ORIGINAL_COMMAND="$*" exec ${WRAPPER}`,
      ].join("\n"),
    );
    chmodSync(fakeSsh, 0o755);
    const host = parseRemoteHost("alice@agent-host", 22);
    await pullTarget(remoteAgentsPaths(join(home, "timeline")), host, "codex", dest, { sshCommand: fakeSsh });
    expect(existsSync(join(dest, "link"))).toBe(false);
  });

  it.skipIf(!canServePulls)("keeps a merge rule the client sends from reading files outside the target", () => {
    // A dir-merge rule makes the sender open the named file in each directory;
    // here that name is a symlink to a rule file outside the target which, if
    // read, would exclude real.jsonl from the transfer.
    const rules = join(home, "outside-rules");
    writeFileSync(rules, "- real.jsonl\n");
    writeFileSync(join(home, ".codex/sessions/real.jsonl"), "{}\n");
    symlinkSync(rules, join(home, ".codex/sessions/rules-link"));
    const fakeSsh = join(home, "fake-ssh");
    writeFileSync(
      fakeSsh,
      [
        "#!/usr/bin/env bash",
        'while [[ $# -gt 0 ]]; do case "$1" in -o|-i|-p|-F|-l) shift 2;; -*) shift;; *) shift; break;; esac; done',
        `HOME=${home} SSH_ORIGINAL_COMMAND="$*" exec ${WRAPPER}`,
      ].join("\n"),
    );
    chmodSync(fakeSsh, 0o755);
    const dest = join(home, "dest");
    mkdirSync(dest);
    const pulled = Bun.spawnSync([
      "rsync", "-rt", "--filter=: rules-link", "-e", fakeSsh, "--rsync-path=timeline-export rsync codex", "host:./", `${dest}/`,
    ]);
    expect(pulled.exitCode).toBe(0);
    expect(existsSync(join(dest, "real.jsonl"))).toBe(true);
  });
});
