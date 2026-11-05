import type { Database } from "bun:sqlite";
import { getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
import { importClaudeCode } from "../../parsers/claude-code";
import { importCodex } from "../../parsers/codex";
import { getSyncSourceRow, parseSyncSourceSettings } from "../config";
import {
  directorySize,
  hostLabel,
  isHostTrusted,
  isRemoteAgentTarget,
  mirrorDir,
  parseRemoteHost,
  probe,
  pullTarget,
  readPublicKey,
  REMOTE_AGENT_TARGETS,
  remoteAgentsPaths,
  type RemoteAgentsPaths,
  type RemoteAgentTarget,
  type RemoteCommandOptions,
  type RemoteHost,
} from "../remote-agents";
import type { SyncOptions, SyncResult, SyncSource } from "../types";

export const REMOTE_AGENTS_SOURCE = "remote-agents";
const DEFAULT_PORT = 22;
const DEFAULT_MAX_STALENESS_HOURS = 24;

/**
 * Importers run against each pulled mirror. A styal statev2 snapshot target
 * plugs in here once the styal importer's table set and signature settle.
 */
const IMPORTERS: Record<RemoteAgentTarget, (db: Database, dir: string, account: string) => Promise<number>> = {
  "claude-code": async (db, dir, account) => (await importClaudeCode(db, dir, account)).messages,
  codex: async (db, dir, account) => {
    const stats = await importCodex(db, dir, account);
    return stats.messages + stats.toolCalls + stats.reasoning;
  },
};

export interface RemoteAgentsConfig {
  host: RemoteHost;
  account: string;
  targets: RemoteAgentTarget[];
  maxStalenessHours: number;
}

/** Parse saved settings; throws with the reason when they are unusable. */
export function parseRemoteAgentsConfig(config: Record<string, unknown> | undefined): RemoteAgentsConfig {
  const target = config?.ssh_target;
  if (typeof target !== "string" || !target) throw new Error("Missing 'ssh_target' in remote-agents settings");
  const account = config?.account;
  if (typeof account !== "string" || !account) throw new Error("Missing 'account' in remote-agents settings");
  const port = config?.ssh_port ?? DEFAULT_PORT;
  if (typeof port !== "number") throw new Error("'ssh_port' must be a number");
  const targets = config?.targets ?? [...REMOTE_AGENT_TARGETS];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("'targets' must be a non-empty list");
  const unknown = targets.filter((entry) => typeof entry !== "string" || !isRemoteAgentTarget(entry));
  if (unknown.length > 0) {
    throw new Error(`Unknown remote-agents targets: ${unknown.join(", ")} (supported: ${REMOTE_AGENT_TARGETS.join(", ")})`);
  }
  const maxStalenessHours = config?.max_staleness_hours ?? DEFAULT_MAX_STALENESS_HOURS;
  if (typeof maxStalenessHours !== "number" || maxStalenessHours <= 0) {
    throw new Error("'max_staleness_hours' must be a positive number");
  }
  return {
    host: parseRemoteHost(target, port),
    account,
    targets: targets as RemoteAgentTarget[],
    maxStalenessHours,
  };
}

/** Last successful pull, keyed by host so retargeting starts the clock afresh. */
interface PullState {
  host: string;
  lastPullAt: string;
}

function lastPullAt(appDb: Database, host: RemoteHost): Date | null {
  const state = getSyncState<PullState>(appDb, REMOTE_AGENTS_SOURCE);
  if (!state || state.host !== hostLabel(host)) return null;
  return new Date(state.lastPullAt);
}

export function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * A sleeping or offline host is normal, so an unreachable host is skipped
 * until its last successful pull is older than the staleness limit.
 */
function unreachableResult(
  config: RemoteAgentsConfig,
  reason: string,
  previousPull: Date | null,
  now: Date,
  metadata: Record<string, unknown>,
  startTime: number,
): SyncResult {
  const label = hostLabel(config.host);
  const ageMs = previousPull ? now.getTime() - previousPull.getTime() : null;
  const base = { source: REMOTE_AGENTS_SOURCE, eventsAdded: 0, eventsUpdated: 0, durationMs: Date.now() - startTime };
  if (ageMs !== null && ageMs < config.maxStalenessHours * 3_600_000) {
    return {
      ...base,
      success: true,
      skipped: true,
      metadata: { ...metadata, skipReason: `${label} unreachable; last successful pull ${formatAge(ageMs)} ago` },
    };
  }
  const since = ageMs === null
    ? "no successful pull yet"
    : `last successful pull ${formatAge(ageMs)} ago exceeds ${config.maxStalenessHours}h`;
  return { ...base, success: false, error: `${label} unreachable (${reason}); ${since}`, metadata };
}

function describeMissingTargets(
  wanted: RemoteAgentTarget[],
  served: Record<string, { available: boolean; detail?: string }>,
): string | null {
  const missing = wanted.filter((target) => !served[target]?.available);
  if (missing.length === 0) return null;
  return missing
    .map((target) => {
      const reported = served[target];
      if (!reported) return `${target}: not served by this timeline-export`;
      return `${target}: ${reported.detail ?? "missing"} not found`;
    })
    .join("; ");
}

export interface RemoteAgentsDeps extends Pick<RemoteCommandOptions, "sshCommand"> {
  paths?: RemoteAgentsPaths;
  appDb?: Database;
  now?: () => Date;
}

export async function syncRemoteAgents(options: SyncOptions, deps: RemoteAgentsDeps = {}): Promise<SyncResult> {
  const startTime = Date.now();
  const paths = deps.paths ?? remoteAgentsPaths();
  const appDb = deps.appDb ?? getAppStateDb();
  const now = deps.now ?? (() => new Date());
  const fail = (error: string, metadata?: Record<string, unknown>): SyncResult => ({
    source: REMOTE_AGENTS_SOURCE,
    success: false,
    eventsAdded: 0,
    eventsUpdated: 0,
    error,
    durationMs: Date.now() - startTime,
    ...(metadata ? { metadata } : {}),
  });

  let config: RemoteAgentsConfig;
  try {
    config = parseRemoteAgentsConfig(options.config.sources[REMOTE_AGENTS_SOURCE]);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const label = hostLabel(config.host);
  if (!readPublicKey(paths)) return fail("No SSH key yet; generate one in the remote-agents settings");
  if (!isHostTrusted(paths, config.host)) {
    return fail(`Host key for ${label} is not trusted yet; use Test connection in the remote-agents settings`);
  }
  const commandOptions = { signal: options.signal, sshCommand: deps.sshCommand };

  try {
    const probed = await probe(paths, config.host, commandOptions);
    const previousPull = lastPullAt(appDb, config.host);
    const baseMetadata = {
      host: label,
      account: config.account,
      lastPullAt: previousPull?.toISOString() ?? null,
    };

    if (probed.kind === "unreachable") {
      return unreachableResult(config, probed.message, previousPull, now(), baseMetadata, startTime);
    }

    const missing = describeMissingTargets(config.targets, probed.targets);
    if (missing) return fail(`${label} cannot serve ${missing}`, baseMetadata);

    for (const target of config.targets) {
      if (options.verbose) console.log(`[${REMOTE_AGENTS_SOURCE}] Pulling ${target} from ${label}`);
      const pulled = await pullTarget(paths, config.host, target, mirrorDir(paths, config.host, target), commandOptions);
      if (pulled.kind === "unreachable") {
        return unreachableResult(config, pulled.message, previousPull, now(), baseMetadata, startTime);
      }
    }
    const pulledAt = now();
    setSyncState(appDb, REMOTE_AGENTS_SOURCE, { host: label, lastPullAt: pulledAt.toISOString() } satisfies PullState);

    const targets: Array<{ target: RemoteAgentTarget; eventsAdded: number; files: number; bytes: number }> = [];
    const db = getDb();
    try {
      initDb(db);
      for (const target of config.targets) {
        const dir = mirrorDir(paths, config.host, target);
        if (options.verbose) console.log(`[${REMOTE_AGENTS_SOURCE}] Importing ${target} as ${config.account}`);
        const eventsAdded = await IMPORTERS[target](db, dir, config.account);
        targets.push({ target, eventsAdded, ...directorySize(dir) });
      }
    } finally {
      db.close();
    }

    return {
      source: REMOTE_AGENTS_SOURCE,
      success: true,
      eventsAdded: targets.reduce((sum, entry) => sum + entry.eventsAdded, 0),
      eventsUpdated: 0,
      durationMs: Date.now() - startTime,
      metadata: { ...baseMetadata, lastPullAt: pulledAt.toISOString(), targets },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), { host: label, account: config.account });
  }
}

function savedSettings(): Record<string, unknown> | undefined {
  const row = getSyncSourceRow(REMOTE_AGENTS_SOURCE);
  return row ? parseSyncSourceSettings(row) : undefined;
}

export const remoteAgentsSyncSource: SyncSource = {
  name: REMOTE_AGENTS_SOURCE,
  description: "Pull Claude Code and Codex sessions from another machine over SSH",
  enabled: true,
  configSchema: [
    {
      key: "ssh_target",
      type: "string",
      label: "SSH target",
      description: "Host running timeline-export, as user@host",
      placeholder: "user@host",
      required: true,
    },
    {
      key: "ssh_port",
      type: "number",
      label: "SSH port",
      integer: true,
      min: 1,
      max: 65535,
      default: DEFAULT_PORT,
    },
    {
      key: "account",
      type: "string",
      label: "Account",
      description: "Account name stored with imported sessions, e.g. user@host",
      required: true,
    },
    {
      key: "targets",
      type: "string-list",
      label: "Targets",
      description: `Logs to pull: ${REMOTE_AGENT_TARGETS.join(", ")}`,
      default: [...REMOTE_AGENT_TARGETS],
    },
    {
      key: "max_staleness_hours",
      type: "number",
      label: "Max staleness (hours)",
      description: "An unreachable host is skipped until its last successful pull is this old, then fails",
      min: 1,
      default: DEFAULT_MAX_STALENESS_HOURS,
    },
  ],

  authStatus() {
    const paths = remoteAgentsPaths();
    if (!readPublicKey(paths)) return "not-configured";
    try {
      const config = parseRemoteAgentsConfig(savedSettings());
      return isHostTrusted(paths, config.host) ? "connected" : "needs-reauth";
    } catch {
      return "needs-reauth";
    }
  },

  // Settings, key, and trust problems fail the run in sync() instead: the
  // scheduler records a canSync refusal as a successful skip, which would hide them.
  async canSync(): Promise<string | null> {
    return null;
  },

  sync: (options) => syncRemoteAgents(options),
};
