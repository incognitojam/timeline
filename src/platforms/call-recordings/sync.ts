/**
 * Call recordings sync source.
 *
 * Runs call-transcribe's `calls list` and imports every recording it reports.
 * The full listing takes well under a second once `calls` has its cache warm,
 * and only records whose fingerprint changed are rewritten, so each run reads
 * everything: that is the only way to see a transcript edited on an old call.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { expandPath } from "../../config";
import { backgroundCommand } from "../../lib/background-priority";
import { getDb, initDb } from "../../db/schema";
import type { SyncOptions, SyncResult, SyncSource } from "../../sync/types";
import { EVENT_SOURCE, type ImportStats, importCallRecordings, parseListing } from "./parser";

/** `calls` takes up to about 75 s when its cache is cold. */
export const CALLS_TIMEOUT_MS = 180_000;

interface ResolvedConfig {
  account: string;
  command: string;
}

function resolveConfig(config: Record<string, unknown> | undefined): ResolvedConfig | string {
  const account = typeof config?.account === "string" ? config.account.trim() : "";
  if (!account) return `Missing 'account' in ${EVENT_SOURCE} sync config`;
  const command = typeof config?.command === "string" ? config.command.trim() : "";
  if (!command) return `Missing 'command' in ${EVENT_SOURCE} sync config`;
  return { account, command: expandPath(command) };
}

export interface RunCallsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run `calls` with `args` and return its stdout. It prints JSON only on
 * stdout and progress on stderr; on failure it exits 1 with `{"error": …}`.
 * It runs from its own folder, as call-transcribe documents.
 */
export function runCalls(command: string, args: readonly string[], options: RunCallsOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? CALLS_TIMEOUT_MS;
  const [file, ...argv] = backgroundCommand([command, ...args]);
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout or cancel also kills anything it started.
    const proc = spawn(file, argv, { cwd: dirname(command), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stdout: Buffer[] = [];
    let stderrTail = "";
    let stopped: string | null = null;
    let settled = false;
    proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
    });
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const stop = (reason: string) => {
      stopped ??= reason;
      try {
        if (proc.pid !== undefined) process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const onAbort = () => stop("was cancelled");
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("error", (error) => {
      settle(() => reject(new Error(`calls ${args.join(" ")} could not start: ${error.message}`)));
    });
    // A stopped run settles when the process exits; pipes a stray descendant
    // still holds must not keep it waiting.
    proc.on("exit", () => {
      if (!stopped) return;
      proc.stdout.destroy();
      proc.stderr.destroy();
      settle(() => reject(new Error(`calls ${args.join(" ")} ${stopped}`)));
    });
    proc.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      settle(() => {
        if (stopped) return reject(new Error(`calls ${args.join(" ")} ${stopped}`));
        if (code === 0) return resolve(out);
        reject(new Error(`calls ${args.join(" ")} exited with code ${code}: ${reportedError(out) ?? stderrTail.trim()}`));
      });
    });
  });
}

/** The `{"error": …}` that `calls` prints on failure, if it printed one. */
function reportedError(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const { error } = parsed as { error: unknown };
      return typeof error === "string" ? error : JSON.stringify(error);
    }
  } catch {
    // Not JSON: fall back to stderr.
  }
  return null;
}

export const callRecordingsSyncSource: SyncSource = {
  name: EVENT_SOURCE,
  description: "Import call recordings and their finished transcripts from call-transcribe's `calls` command",
  enabled: true,
  defaultInterval: "1h",
  configSchema: [
    {
      key: "account",
      type: "string",
      label: "Account label",
      required: true,
      description: "Stored as source_account on every event (e.g. your name).",
    },
    {
      key: "command",
      type: "string",
      format: "path",
      label: "calls command",
      required: true,
      description: "Path to the `calls` script in your call-transcribe folder",
    },
  ],

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const resolved = resolveConfig(config);
    if (typeof resolved === "string") return resolved;
    try {
      accessSync(resolved.command, constants.X_OK);
    } catch {
      return `calls command not found or not executable at ${resolved.command}`;
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const resolved = resolveConfig(options.config.sources[EVENT_SOURCE]);
    const failure = (error: string): SyncResult => ({
      source: EVENT_SOURCE,
      success: false,
      eventsAdded: 0,
      eventsUpdated: 0,
      error,
      durationMs: Date.now() - startTime,
    });
    if (typeof resolved === "string") return failure(resolved);

    let stats: ImportStats;
    try {
      const listing = parseListing(await runCalls(resolved.command, ["list"], { signal: options.signal }));
      const db = getDb();
      try {
        initDb(db);
        stats = importCallRecordings(db, listing, {
          sourceAccount: resolved.account,
          importBatch: `${EVENT_SOURCE}-${resolved.account}-${startTime}`,
        });
      } finally {
        db.close();
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
    return {
      source: EVENT_SOURCE,
      success: true,
      eventsAdded: stats.imported,
      eventsUpdated: stats.updated + stats.renamed,
      durationMs: Date.now() - startTime,
      metadata: { ...stats },
    };
  },
};
