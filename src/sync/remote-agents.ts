/**
 * Remote agent hosts: the SSH plumbing behind the `remote-agents` sync source.
 *
 * Timeline pulls agent logs from another machine over SSH with a key it owns.
 * The remote end pins that key to tools/timeline-export/timeline-export, which
 * only answers a probe and serves read-only rsync of allow-listed targets.
 * Timeline keeps its own known_hosts so trust is explicit and independent of
 * the service user's ~/.ssh.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { getRemoteAgentsDir, getTimelineDbPath } from "../db/paths";

/**
 * Targets this Timeline can import. Each remote host's installed
 * timeline-export reports the targets it serves in its probe, and a run fails
 * when a requested target is not among them, so the two lists may differ.
 */
export const REMOTE_AGENT_TARGETS = ["claude-code", "codex"] as const;
export type RemoteAgentTarget = (typeof REMOTE_AGENT_TARGETS)[number];

export function isRemoteAgentTarget(value: string): value is RemoteAgentTarget {
  return (REMOTE_AGENT_TARGETS as readonly string[]).includes(value);
}

/** Path of the forced command on the remote host, as written into authorized_keys. */
export const REMOTE_EXPORT_COMMAND = "~/.local/bin/timeline-export";
const EXPORT_PROTOCOL = "1";
const CONNECT_TIMEOUT_SECONDS = 10;

export interface RemoteHost {
  /** `user@host` or `host`, as passed to ssh. */
  target: string;
  host: string;
  port: number;
}

const SSH_TARGET_RE = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9][A-Za-z0-9.-]*)$/;

export function parseRemoteHost(target: string, port: number): RemoteHost {
  const match = SSH_TARGET_RE.exec(target);
  if (!match?.[1]) {
    throw new Error(`Invalid SSH target "${target}"; expected user@host or host`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SSH port ${port}`);
  }
  return { target, host: match[1], port };
}

/** Host token as it appears in known_hosts. */
export function knownHostsName(host: RemoteHost): string {
  return host.port === 22 ? host.host : `[${host.host}]:${host.port}`;
}

export function hostLabel(host: RemoteHost): string {
  return host.port === 22 ? host.target : `${host.target}:${host.port}`;
}

export interface RemoteAgentsPaths {
  dir: string;
  privateKey: string;
  publicKey: string;
  knownHosts: string;
}

export function remoteAgentsPaths(dir: string = getRemoteAgentsDir(getTimelineDbPath())): RemoteAgentsPaths {
  return {
    dir,
    privateKey: join(dir, "id_ed25519"),
    publicKey: join(dir, "id_ed25519.pub"),
    knownHosts: join(dir, "known_hosts"),
  };
}

export function mirrorDir(paths: RemoteAgentsPaths, host: RemoteHost, target: RemoteAgentTarget): string {
  return join(paths.dir, "mirror", knownHostsName(host), target);
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: string[],
  options: { signal?: AbortSignal; stdin?: string; cwd?: string } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function commandError(label: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return new Error(`${label} failed: ${detail}`);
}

// ---------------------------------------------------------------------------
// Key and host trust
// ---------------------------------------------------------------------------

export function readPublicKey(paths: RemoteAgentsPaths): string | null {
  if (!existsSync(paths.privateKey) || !existsSync(paths.publicKey)) return null;
  return readFileSync(paths.publicKey, "utf8").trim();
}

export function authorizedKeysLine(publicKey: string): string {
  return `restrict,command="${REMOTE_EXPORT_COMMAND}" ${publicKey}`;
}

export class KeyExistsError extends Error {
  constructor() {
    super("An SSH key already exists; pass replace to rotate it");
    this.name = "KeyExistsError";
  }
}

let keyGeneration: Promise<unknown> = Promise.resolve();

/**
 * Create Timeline's SSH key, replacing an existing one only when asked.
 * Requests are serialised so concurrent callers cannot both pass the
 * existence check, and the pair is generated aside then renamed into place.
 */
export function generateKey(paths: RemoteAgentsPaths, options: { replace: boolean }): Promise<string> {
  const generated = keyGeneration.then(() => generateKeyNow(paths, options));
  keyGeneration = generated.catch(() => {});
  return generated;
}

async function generateKeyNow(paths: RemoteAgentsPaths, options: { replace: boolean }): Promise<string> {
  if (readPublicKey(paths) && !options.replace) {
    throw new KeyExistsError();
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const staged = `${paths.privateKey}.${randomUUID()}`;
  try {
    const result = await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `timeline@${hostname()}`, "-f", staged]);
    if (result.exitCode !== 0) throw commandError("ssh-keygen", result);
    renameSync(`${staged}.pub`, paths.publicKey);
    renameSync(staged, paths.privateKey);
  } finally {
    rmSync(staged, { force: true });
    rmSync(`${staged}.pub`, { force: true });
  }
  const publicKey = readPublicKey(paths);
  if (!publicKey) throw new Error(`ssh-keygen did not write ${paths.publicKey}`);
  return publicKey;
}

export function isHostTrusted(paths: RemoteAgentsPaths, host: RemoteHost): boolean {
  if (!existsSync(paths.knownHosts)) return false;
  const name = knownHostsName(host);
  return readFileSync(paths.knownHosts, "utf8")
    .split("\n")
    .some((line) => line.split(" ")[0]?.split(",").includes(name));
}

export interface ScannedHostKey {
  line: string;
  fingerprint: string;
}

/** Fetch the host's ed25519 key and its SHA256 fingerprint, for the user to confirm. */
export async function scanHostKey(host: RemoteHost): Promise<ScannedHostKey> {
  const scan = await run([
    "ssh-keyscan", "-T", String(CONNECT_TIMEOUT_SECONDS), "-t", "ed25519", "-p", String(host.port), host.host,
  ]);
  const line = scan.stdout.split("\n").find((candidate) => candidate.trim() && !candidate.startsWith("#"));
  if (!line) {
    throw new Error(`Could not read an ed25519 host key from ${hostLabel(host)}: ${scan.stderr.trim() || "no response"}`);
  }
  const fingerprint = await run(["ssh-keygen", "-l", "-E", "sha256", "-f", "-"], { stdin: `${line}\n` });
  if (fingerprint.exitCode !== 0) throw commandError("ssh-keygen -l", fingerprint);
  const sha = fingerprint.stdout.split(" ").find((part) => part.startsWith("SHA256:"));
  if (!sha) throw new Error(`Unexpected ssh-keygen fingerprint output: ${fingerprint.stdout.trim()}`);
  return { line: line.trim(), fingerprint: sha };
}

/**
 * Pin the host key, provided it still matches the fingerprint the user saw.
 * Replaces any key previously pinned for the same host.
 */
export async function trustHost(paths: RemoteAgentsPaths, host: RemoteHost, fingerprint: string): Promise<void> {
  const scanned = await scanHostKey(host);
  if (scanned.fingerprint !== fingerprint) {
    throw new Error(
      `Host key for ${hostLabel(host)} changed: expected ${fingerprint}, got ${scanned.fingerprint}`,
    );
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const name = knownHostsName(host);
  const kept = existsSync(paths.knownHosts)
    ? readFileSync(paths.knownHosts, "utf8")
      .split("\n")
      .filter((line) => line.trim() && !line.split(" ")[0]?.split(",").includes(name))
    : [];
  writeFileSync(paths.knownHosts, `${[...kept, scanned.line].join("\n")}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Probe and pull
// ---------------------------------------------------------------------------

export interface RemoteCommandOptions {
  signal?: AbortSignal;
  /** ssh executable; tests substitute a local stand-in. */
  sshCommand?: string;
}

/**
 * ssh options shared by probe and pull, which both run with cwd = paths.dir. The
 * key and known_hosts stay relative so a data directory with spaces cannot reach
 * ssh, which splits UserKnownHostsFile on them, or rsync's -e, which macOS
 * openrsync splits on spaces without honouring quotes.
 */
function sshOptions(paths: RemoteAgentsPaths, host: RemoteHost): string[] {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  return [
    "-F", "/dev/null",
    "-i", relative(paths.dir, paths.privateKey),
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    // Only Timeline's own pin decides trust: no system-wide keys, no automatic updates.
    "-o", `UserKnownHostsFile=${relative(paths.dir, paths.knownHosts)}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "UpdateHostKeys=no",
    "-o", `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
    // Give up on a host that stops answering mid-transfer (asleep, network gone).
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-p", String(host.port),
  ];
}

/** ssh's messages for a host that cannot be reached, as opposed to one that refuses us. */
const UNREACHABLE_PATTERNS = [
  /connection timed out/i,
  /operation timed out/i,
  /no route to host/i,
  /network is unreachable/i,
  /host is down/i,
  /could not resolve hostname/i,
  /connection refused/i,
  /timeout, server .* not responding/i,
  /connection reset/i,
];

function isUnreachable(stderr: string): boolean {
  return UNREACHABLE_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** The host's key no longer matches the pinned one (or none is pinned); the user must confirm the new one. */
export class HostKeyMismatchError extends Error {
  constructor(host: RemoteHost, detail: string) {
    super(
      `Host key for ${hostLabel(host)} does not match the trusted key; if the host was reinstalled, ` +
        `confirm its new fingerprint with Test connection in the remote-agents settings (${detail})`,
    );
    this.name = "HostKeyMismatchError";
  }
}

const HOST_KEY_MISMATCH = /host key verification failed/i;

export type ProbeResult =
  | { kind: "ok"; targets: Record<string, { available: boolean; detail?: string }> }
  | { kind: "unreachable"; message: string };

/**
 * Ask the remote wrapper which targets it serves. Distinguishes an unreachable
 * host (normal for a sleeping machine) from every other failure, which throws.
 */
export async function probe(
  paths: RemoteAgentsPaths,
  host: RemoteHost,
  options: RemoteCommandOptions = {},
): Promise<ProbeResult> {
  const result = await run(
    [options.sshCommand ?? "ssh", ...sshOptions(paths, host), host.target, "timeline-export probe"],
    { signal: options.signal, cwd: paths.dir },
  );
  if (result.exitCode === 255 && isUnreachable(result.stderr)) {
    return { kind: "unreachable", message: result.stderr.trim() };
  }
  if (result.exitCode === 255 && HOST_KEY_MISMATCH.test(result.stderr)) {
    const lastLine = result.stderr.trim().split("\n").at(-1) ?? "";
    throw new HostKeyMismatchError(host, lastLine);
  }
  if (result.exitCode !== 0) throw commandError(`ssh to ${hostLabel(host)}`, result);

  const [header, ...lines] = result.stdout.trim().split("\n");
  if (header !== `timeline-export ${EXPORT_PROTOCOL}`) {
    throw new Error(
      `${hostLabel(host)} did not answer as timeline-export protocol ${EXPORT_PROTOCOL} ` +
        `(got "${header ?? ""}"); is its authorized_keys entry using ${REMOTE_EXPORT_COMMAND}?`,
    );
  }
  const targets: Record<string, { available: boolean; detail?: string }> = {};
  for (const line of lines) {
    const [kind, name, state, detail] = line.split("\t");
    if (kind !== "target" || !name) throw new Error(`Unexpected timeline-export probe line: ${line}`);
    targets[name] = { available: state === "ok", ...(detail ? { detail } : {}) };
  }
  return { kind: "ok", targets };
}

export type PullResult = { kind: "ok" } | { kind: "unreachable"; message: string };

/**
 * Mirror one target into `dest`, deleting files the remote no longer has. A host
 * lost after the probe is reported like an unreachable probe; other failures throw.
 */
export async function pullTarget(
  paths: RemoteAgentsPaths,
  host: RemoteHost,
  target: RemoteAgentTarget,
  dest: string,
  options: RemoteCommandOptions = {},
): Promise<PullResult> {
  const sshCommand = [options.sshCommand ?? "ssh", ...sshOptions(paths, host)];
  if (sshCommand.some((part) => /\s/.test(part))) {
    throw new Error(`rsync cannot pass whitespace in its ssh command: ${sshCommand.join(" ")}`);
  }
  mkdirSync(dest, { recursive: true });
  // -rt without -l: symlinks are skipped rather than recreated locally.
  const result = await run(
    [
      "rsync", "-rt", "--delete",
      "-e", sshCommand.join(" "),
      `--rsync-path=timeline-export rsync ${target}`,
      `${host.target}:./`,
      `${dest}/`,
    ],
    { signal: options.signal, cwd: paths.dir },
  );
  if (result.exitCode === 0) return { kind: "ok" };
  if (isUnreachable(result.stderr)) return { kind: "unreachable", message: result.stderr.trim() };
  throw commandError(`rsync of ${target} from ${hostLabel(host)}`, result);
}

export function directorySize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += statSync(join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}
