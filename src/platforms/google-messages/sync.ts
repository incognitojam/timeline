/**
 * Google Messages sync source.
 *
 * Runs the paired `timeline-gmessages` sidecar (tools/timeline-gmessages) as a
 * one-shot subprocess and imports its JSONL output. The sidecar owns the
 * Google session (`session.json` in the state directory); this source only
 * tracks cursors — one per conversation, persisted as each conversation
 * completes, so an interrupted run (network, sleep, restart) resumes where it
 * stopped instead of starting over. See docs/source-setup.md.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expandPath } from "../../config";
import { getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
import type { SyncOptions, SyncResult, SyncSource } from "../../sync/types";
import { EVENT_SOURCE, importGoogleMessages, type ImportStats } from "./parser";
import { backgroundCommand } from "../../lib/background-priority";

export const DEFAULT_STATE_DIR = "~/.local/share/timeline-gmessages";
export const DEFAULT_BINARY = `${DEFAULT_STATE_DIR}/timeline-gmessages`;
export const SESSION_FILE = "session.json";
/**
 * Re-fetch this far behind a conversation's cursor so messages that land with
 * an older timestamp (delayed delivery, phone clock skew) are not missed;
 * re-imports are no-ops on the unique source_id.
 */
export const SYNC_OVERLAP_MS = 60 * 60 * 1000;
/**
 * Prefix of the per-run directory (inside the state dir) the sidecar downloads
 * media into. Files leave it as the importer stores them; the directory is
 * removed when the run ends, and any left behind by a crash is swept next run.
 */
export const MEDIA_STAGING_PREFIX = "media-staging-";

export interface GoogleMessagesSyncState {
  /** Conversation id → wall-clock start (Unix ms) of the run that last fully paged it. */
  conversations: Record<string, number>;
}

interface ResolvedConfig {
  account: string;
  binary: string;
  stateDir: string;
}

function resolveConfig(config: Record<string, unknown> | undefined): ResolvedConfig | string {
  const account = typeof config?.account === "string" ? config.account.trim() : "";
  if (!account) return `Missing 'account' in ${EVENT_SOURCE} sync config`;
  const binary = expandPath(typeof config?.binary === "string" && config.binary !== "" ? config.binary : DEFAULT_BINARY);
  const stateDir = expandPath(typeof config?.state_dir === "string" && config.state_dir !== "" ? config.state_dir : DEFAULT_STATE_DIR);
  return { account, binary, stateDir };
}

function loadState(): GoogleMessagesSyncState {
  const state = getSyncState<Partial<GoogleMessagesSyncState>>(getAppStateDb(), EVENT_SOURCE);
  return { conversations: state?.conversations ?? {} };
}

/** Per-conversation `since` values handed to the sidecar. */
export function cursorsFor(state: GoogleMessagesSyncState): Record<string, number> {
  return Object.fromEntries(
    Object.entries(state.conversations).map(([id, completedAt]) => [id, Math.max(0, completedAt - SYNC_OVERLAP_MS)]),
  );
}

function createMediaStaging(stateDir: string): string {
  for (const entry of readdirSync(stateDir)) {
    if (entry.startsWith(MEDIA_STAGING_PREFIX)) rmSync(join(stateDir, entry), { recursive: true, force: true });
  }
  return mkdtempSync(join(stateDir, MEDIA_STAGING_PREFIX));
}

interface SidecarRun<T> {
  exitCode: number | null;
  stderrTail: string;
  result: T;
}

/**
 * Spawn the sidecar with the cursor map on stdin and stream its JSONL stdout
 * into `consume`, downloading attachments into `mediaDir`. If consuming
 * throws, the sidecar is killed so it cannot linger blocked on a full pipe.
 */
async function runSidecar<T>(
  config: ResolvedConfig,
  cursors: Record<string, number>,
  mediaDir: string,
  signal: AbortSignal | undefined,
  consume: (lines: AsyncIterable<string>) => Promise<T>,
): Promise<SidecarRun<T>> {
  const [command, ...args] = backgroundCommand([config.binary, "dump", "-folder", "all", "-cursors", "-", "-media", mediaDir]);
  const proc = spawn(command, args, {
    cwd: config.stateDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderrTail = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4_000);
  });
  let spawnError: Error | null = null;
  // "close" waits for stdio to drain (the normal path); "exit" fires as soon
  // as the process is gone, which is all the kill path can rely on — a
  // descendant could keep the pipe open.
  const closed = new Promise<number | null>((resolve) => {
    proc.on("error", (error) => {
      spawnError = error;
      resolve(null);
    });
    proc.on("close", resolve);
  });
  const exited = new Promise<void>((resolve) => {
    proc.on("error", () => resolve());
    proc.on("exit", () => resolve());
  });
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  // A spawn failure surfaces via the "error" event; a write to its dead stdin
  // must not raise a second, unhandled one.
  proc.stdin.on("error", () => {});
  proc.stdin.end(JSON.stringify(cursors));

  try {
    const result = await consume(createInterface({ input: proc.stdout, crlfDelay: Number.POSITIVE_INFINITY }));
    const exitCode = await closed;
    if (spawnError) throw spawnError;
    return { exitCode, stderrTail, result };
  } catch (error) {
    proc.kill();
    await exited;
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export const googleMessagesSyncSource: SyncSource = {
  name: EVENT_SOURCE,
  description: "Sync SMS, MMS and RCS messages and their attachments from Google Messages via the paired timeline-gmessages sidecar",
  enabled: true,
  configSchema: [
    {
      key: "account",
      type: "string",
      label: "Account label",
      required: true,
      description: "Stored as source_account on every event (e.g. your name or the phone's nickname).",
    },
    {
      key: "binary",
      type: "string",
      format: "path",
      label: "Sidecar binary",
      default: DEFAULT_BINARY,
      description: "Built from tools/timeline-gmessages",
    },
    {
      key: "state_dir",
      type: "string",
      format: "path",
      label: "State directory",
      default: DEFAULT_STATE_DIR,
      description: "Holds session.json written by `timeline-gmessages pair`",
    },
  ],

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const resolved = resolveConfig(config);
    if (typeof resolved === "string") return resolved;
    try {
      accessSync(resolved.binary, constants.X_OK);
    } catch {
      return `Sidecar binary not found or not executable at ${resolved.binary}`;
    }
    if (!existsSync(join(resolved.stateDir, SESSION_FILE))) {
      return `Not paired: run \`${resolved.binary} pair\` in ${resolved.stateDir}`;
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const fail = (error: string, stats?: ImportStats): SyncResult => ({
      source: EVENT_SOURCE,
      success: false,
      eventsAdded: stats?.imported ?? 0,
      eventsUpdated: 0,
      error,
      durationMs: Date.now() - startTime,
      ...(stats ? { metadata: metadataFor(stats) } : {}),
    });

    const resolved = resolveConfig(options.config.sources[EVENT_SOURCE]);
    if (typeof resolved === "string") return fail(resolved);

    const appState = getAppStateDb();
    const state = loadState();
    const cursors = cursorsFor(state);

    const db = getDb();
    initDb(db);
    let mediaDir: string | undefined;
    try {
      mediaDir = createMediaStaging(resolved.stateDir);
      const run = await runSidecar<ImportStats>(resolved, cursors, mediaDir, options.signal, (lines) =>
        importGoogleMessages(db, lines, {
          sourceAccount: resolved.account,
          importBatch: `${EVENT_SOURCE}-${resolved.account}-${startTime}`,
          mediaDir,
          onConversationDone: (conversationId) => {
            state.conversations[conversationId] = startTime;
            setSyncState(appState, EVENT_SOURCE, state);
          },
        }),
      );
      const stats = run.result;
      if (run.exitCode !== 0) {
        return fail(`timeline-gmessages exited with code ${run.exitCode}: ${run.stderrTail.trim()}`, stats);
      }
      if (stats.conversationsFailed.length > 0) {
        return fail(
          `${stats.conversationsFailed.length} conversation(s) could not be fully paged (will retry next run): ${stats.conversationsFailed.join(", ")}`,
          stats,
        );
      }
      return {
        source: EVENT_SOURCE,
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
        metadata: { ...metadataFor(stats), resumedConversations: Object.keys(cursors).length },
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    } finally {
      db.close();
      if (mediaDir) rmSync(mediaDir, { recursive: true, force: true });
    }
  },
};

function metadataFor(stats: ImportStats): Record<string, unknown> {
  const { imported: _imported, conversationsFailed, ...rest } = stats;
  return { ...rest, conversationsFailed: conversationsFailed.length };
}
