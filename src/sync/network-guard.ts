/**
 * Network guard for sync sources.
 *
 * Lets a sync source defer a run based on current network conditions — the
 * motivating case being "don't upload database/media backups to R2 while
 * tethered to my iPhone." A guarded run that hits a blocked condition is
 * *skipped*, not failed: the scheduler records it as a deferral and tries again
 * next interval (see {@link evaluateNetworkGuard} and the scheduler's guard
 * hook).
 *
 * Opt-in per source via the settings in {@link NETWORK_GUARD_CONFIG_FIELDS}. The
 * blocked Wi-Fi networks themselves are one instance-wide list (edited under
 * Settings → Network), since whether a network is a hotspot is a fact about the
 * network; each source only chooses whether to avoid them.
 *
 * Like `lib/http-retry`, Effect stays *internal*: detection is an Effect
 * pipeline (timeout + fail-to-undefined), but the module's surface is plain
 * values and `Promise`s so callers need no Effect import. The decision itself
 * ({@link evaluateNetworkGuard}) is a pure function, unit-tested with an
 * injected {@link NetworkStatus} so tests never touch the real network.
 *
 * Cheap checks only for now. `min_upload_mbps` (needs a throughput probe + TTL
 * cache) is deferred to later rungs, as is a non-macOS detection provider.
 */

import { Duration, Effect } from "effect";
import type { SyncSourceConfigField } from "./types";

export const DEFAULT_SKIP_BLOCKED_NETWORKS = false;
export const DEFAULT_REQUIRE_UNMETERED = false;
export const DEFAULT_NETWORK_GUARD_ON_UNKNOWN = "proceed";

export const NETWORK_GUARD_CONFIG_FIELDS: SyncSourceConfigField[] = [
  {
    key: "skip_blocked_networks",
    type: "boolean",
    label: "Skip on blocked Wi-Fi networks",
    description: "Skip while connected to a Wi-Fi network blocked in Settings",
    default: DEFAULT_SKIP_BLOCKED_NETWORKS,
  },
  {
    key: "require_unmetered",
    type: "boolean",
    label: "Require unmetered network",
    description: "Skip on expensive or constrained network connections",
    default: DEFAULT_REQUIRE_UNMETERED,
  },
  {
    key: "on_unknown",
    type: "select",
    label: "When network status is unknown",
    description: "Choose whether to run when network checks cannot be determined",
    options: ["proceed", "skip"],
    default: DEFAULT_NETWORK_GUARD_ON_UNKNOWN,
  },
];

/** Validated network-guard config for one source. */
export interface NetworkGuardConfig {
  /**
   * SSID substrings (case-insensitive) that block the run. An active Wi-Fi
   * network is blocked if its name *contains* any entry — so `"iPhone"` also
   * matches `"Alice's iPhone"`, which is how personal hotspots appear.
   */
  blockedSsids: string[];
  /** Skip when the active path is marked expensive or constrained. */
  requireUnmetered: boolean;
  /** What to do when a configured check can't be determined. Defaults to `"proceed"`. */
  onUnknown: "proceed" | "skip";
}

/**
 * Observed network state.
 *
 * `ssid` is deliberately tri-state: a string when connected to a named Wi-Fi
 * network, `null` when definitively not on Wi-Fi (ethernet / Wi-Fi off), and
 * `undefined` when it could not be read (permission-gated or detection failed)
 * — which is what {@link NetworkGuardConfig.onUnknown} resolves.
 */
export interface NetworkStatus {
  ssid: string | null | undefined;
  /** Whether the active Network.framework path is using Wi-Fi. */
  usesWifi?: boolean;
  /** Network.framework's expensive-path signal. */
  isExpensive?: boolean;
  /** Network.framework's constrained/Low Data Mode signal. */
  isConstrained?: boolean;
}

/** A guard either proceeds, or skips the run with a human-readable reason. */
export type GuardDecision = { skip: false } | { skip: true; reason: string };

/** Detection function shape; swappable in tests. */
export type DetectNetworkStatus = () => Promise<NetworkStatus>;

export function meteredFromStatus(status: NetworkStatus): boolean | undefined {
  if (status.isExpensive === true || status.isConstrained === true) return true;
  if (status.isExpensive === false && status.isConstrained === false) return false;
  return undefined;
}

/**
 * Parse the network-guard keys out of a source's settings, resolving
 * `skip_blocked_networks` against the instance-wide `blockedNetworks`. Returns
 * `null` when the source declares no usable guard config (the guard is opt-in).
 */
export function parseNetworkGuardConfig(
  raw: Record<string, unknown> | undefined,
  blockedNetworks: readonly string[],
): NetworkGuardConfig | null {
  if (!raw) return null;

  const skipBlockedRaw = raw.skip_blocked_networks;
  const requireUnmeteredRaw = raw.require_unmetered;
  const onUnknownRaw = raw.on_unknown;
  if (skipBlockedRaw === undefined && requireUnmeteredRaw === undefined && onUnknownRaw === undefined) {
    return null;
  }

  let skipBlocked = DEFAULT_SKIP_BLOCKED_NETWORKS;
  if (skipBlockedRaw !== undefined) {
    if (typeof skipBlockedRaw !== "boolean") {
      throw new Error("[sync.*] skip_blocked_networks must be a boolean");
    }
    skipBlocked = skipBlockedRaw;
  }
  const blockedSsids = skipBlocked ? [...blockedNetworks] : [];

  let requireUnmetered = DEFAULT_REQUIRE_UNMETERED;
  if (requireUnmeteredRaw !== undefined) {
    if (typeof requireUnmeteredRaw !== "boolean") {
      throw new Error("[sync.*] require_unmetered must be a boolean");
    }
    requireUnmetered = requireUnmeteredRaw;
  }

  let onUnknown: NetworkGuardConfig["onUnknown"] = DEFAULT_NETWORK_GUARD_ON_UNKNOWN;
  if (onUnknownRaw !== undefined) {
    if (onUnknownRaw !== "proceed" && onUnknownRaw !== "skip") {
      throw new Error('[sync.*] on_unknown must be "proceed" or "skip"');
    }
    onUnknown = onUnknownRaw;
  }

  // `on_unknown` only governs configured checks; by itself there is nothing to
  // evaluate, so the source is effectively unguarded.
  if (blockedSsids.length === 0 && !requireUnmetered) return null;

  return { blockedSsids, requireUnmetered, onUnknown };
}

/**
 * Pure decision: given config and an observed status, decide whether to skip.
 */
export function evaluateNetworkGuard(
  config: NetworkGuardConfig,
  status: NetworkStatus,
): GuardDecision {
  const { ssid } = status;
  if (config.blockedSsids.length > 0) {
    if (ssid === undefined && config.onUnknown === "skip") {
      return { skip: true, reason: "Wi-Fi SSID could not be determined" };
    }

    if (ssid !== undefined && ssid !== null) {
      const lower = ssid.toLowerCase();
      const blocked = config.blockedSsids.find((needle) =>
        lower.includes(needle.toLowerCase()),
      );
      if (blocked) {
        return {
          skip: true,
          reason: `Wi-Fi network "${ssid}" matches blocked pattern "${blocked}"`,
        };
      }
    }
  }

  if (config.requireUnmetered) {
    const metered = meteredFromStatus(status);
    if (metered === true) {
      return { skip: true, reason: meteredReason(status) };
    }
    if (metered === undefined && config.onUnknown === "skip") {
      return { skip: true, reason: "Metered network status could not be determined" };
    }
  }

  return { skip: false };
}

function meteredReason(status: NetworkStatus): string {
  if (status.isExpensive === true && status.isConstrained === true) {
    return "Network is metered (expensive and constrained)";
  }
  if (status.isExpensive === true) return "Network is metered (expensive)";
  if (status.isConstrained === true) return "Network is metered (constrained)";
  return "Network is metered";
}

/**
 * Detect current network status, then decide. Detection never throws — failures
 * become an undetermined SSID, which {@link NetworkGuardConfig.onUnknown}
 * resolves. Returns the status alongside the decision so callers can record the
 * observed network in skip metadata.
 */
export async function checkNetworkGuard(
  config: NetworkGuardConfig,
  options: { detect?: DetectNetworkStatus } = {},
): Promise<{ decision: GuardDecision; status: NetworkStatus }> {
  const detect = options.detect ?? detectNetworkStatus;
  const status = await detect();
  return { decision: evaluateNetworkGuard(config, status), status };
}

// --- Detection (Effect internal) -------------------------------------------

/** networksetup is fast (tens of ms); cap it so a hung shell can't stall sync. */
const DETECT_TIMEOUT = Duration.seconds(3);

interface MacosPathStatus {
  usesWifi: boolean;
  isExpensive: boolean;
  isConstrained: boolean;
}

const MACOS_NW_PATH_PROBE = `
import Darwin
import Dispatch
import Foundation
import Network

let monitor = NWPathMonitor()
let queue = DispatchQueue(label: "timeline.network-guard")
let semaphore = DispatchSemaphore(value: 0)

final class PathBox {
  var path: NWPath?
}

let box = PathBox()

func jsonBool(_ value: Bool) -> String {
  return value ? "true" : "false"
}

monitor.pathUpdateHandler = { path in
  box.path = path
  semaphore.signal()
}

monitor.start(queue: queue)
let outcome = semaphore.wait(timeout: .now() + 3)
monitor.cancel()

if outcome == .timedOut {
  exit(1)
}

guard let path = box.path else {
  exit(1)
}

print("{\\"status\\":\\"\\(path.status)\\",\\"usesWifi\\":\\(jsonBool(path.usesInterfaceType(.wifi))),\\"isExpensive\\":\\(jsonBool(path.isExpensive)),\\"isConstrained\\":\\(jsonBool(path.isConstrained))}")
`;

async function runCommand(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`${cmd[0]} exited with code ${exitCode}`);
  return stdout;
}

function parseMacosPathStatus(output: string): MacosPathStatus | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;

  const value = parsed as Record<string, unknown>;
  if (
    typeof value.usesWifi !== "boolean" ||
    typeof value.isExpensive !== "boolean" ||
    typeof value.isConstrained !== "boolean"
  ) {
    return undefined;
  }

  return {
    usesWifi: value.usesWifi,
    isExpensive: value.isExpensive,
    isConstrained: value.isConstrained,
  };
}

/** Find the macOS Wi-Fi interface (e.g. "en0"), or null if there is none. */
async function macosWifiDevice(): Promise<string | null> {
  const output = await runCommand(["networksetup", "-listallhardwareports"]);
  const blocks = output.split(/\n(?=Hardware Port:)/);
  for (const block of blocks) {
    if (/Hardware Port:\s*Wi-Fi/i.test(block)) {
      const match = block.match(/Device:\s*(\S+)/);
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * Parse `networksetup -getairportnetwork` output.
 * - `"Current Wi-Fi Network: <name>"` with a name → that SSID
 * - same line but empty → `undefined` (redacted without Location Services)
 * - "not associated" → `undefined` unless Network.framework confirms not Wi-Fi
 * - "power is currently off" → `null` (not on Wi-Fi)
 * - anything unexpected → `undefined`
 */
export function parseAirportNetwork(
  output: string,
  options: { usesWifi?: boolean } = {},
): string | null | undefined {
  const text = output.trim();
  const match = text.match(/Current Wi-Fi Network:\s*(.*)$/m);
  if (match) {
    const name = match[1].trim();
    return name.length > 0 ? name : undefined;
  }
  if (/power is currently off/i.test(text)) return null;
  if (/not associated/i.test(text)) return options.usesWifi === false ? null : undefined;
  return undefined;
}

const detectMacosPathStatus = Effect.gen(function* () {
  const output = yield* Effect.tryPromise(() =>
    runCommand(["/usr/bin/swift", "-e", MACOS_NW_PATH_PROBE]),
  );
  return parseMacosPathStatus(output);
}).pipe(
  Effect.timeout(DETECT_TIMEOUT),
  Effect.orElseSucceed(() => undefined),
);

function detectMacosSsid(pathStatus: MacosPathStatus | undefined) {
  return Effect.gen(function* () {
    if (pathStatus?.usesWifi === false) return null;

    const device = yield* Effect.tryPromise(() => macosWifiDevice());
    if (device === null) return null;
    const output = yield* Effect.tryPromise(() =>
      runCommand(["networksetup", "-getairportnetwork", device]),
    );
    return parseAirportNetwork(output, { usesWifi: pathStatus?.usesWifi });
  }).pipe(
    Effect.timeout(DETECT_TIMEOUT),
    // Any failure (spawn error, timeout, redaction) → undetermined, not a crash.
    Effect.orElseSucceed(() => undefined),
  );
}

/**
 * Best-effort current network status. macOS reads the active Wi-Fi SSID via
 * `networksetup` and metered state via Network.framework; other platforms
 * report undetermined status (provider deferred), so `on_unknown` governs
 * there.
 */
export async function detectNetworkStatus(): Promise<NetworkStatus> {
  if (process.platform !== "darwin") return { ssid: undefined };

  const pathStatus = await Effect.runPromise(detectMacosPathStatus);
  const ssid = await Effect.runPromise(detectMacosSsid(pathStatus));

  return {
    ssid,
    usesWifi: pathStatus?.usesWifi,
    isExpensive: pathStatus?.isExpensive,
    isConstrained: pathStatus?.isConstrained,
  };
}
