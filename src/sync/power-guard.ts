/**
 * Power guard for sync sources: defer heavy local work (embedding, inference)
 * while the Mac runs on battery or in Low Power Mode. Like the network guard it
 * is opt-in per source and a guarded run is skipped, not failed.
 *
 * Detection reads `pmset`, so it only works on macOS; a source that opts in
 * elsewhere, or a `pmset` reply that cannot be parsed, fails the run rather than
 * running unguarded.
 */

import type { GuardDecision } from "./network-guard";
import type { SyncSourceConfigField } from "./types";

export const POWER_GUARD_CONFIG_FIELDS: SyncSourceConfigField[] = [
  {
    key: "require_ac_power",
    type: "boolean",
    label: "Require AC power",
    description: "Skip while running on battery or with Low Power Mode on",
    default: false,
  },
];

export interface PowerStatus {
  onBattery: boolean;
  lowPowerMode: boolean;
}

/** Whether a source opted into the power guard. */
export function parsePowerGuardConfig(raw: Record<string, unknown> | undefined): boolean {
  const value = raw?.require_ac_power;
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("[sync.*] require_ac_power must be a boolean");
  return value;
}

export function evaluatePowerGuard(status: PowerStatus): GuardDecision {
  if (status.onBattery) return { skip: true, reason: "Running on battery power" };
  if (status.lowPowerMode) return { skip: true, reason: "Low Power Mode is on" };
  return { skip: false };
}

/** Parse `pmset -g batt`, whose first line names the current power source. */
export function parsePowerSource(output: string): boolean {
  const match = output.match(/Now drawing from '([^']+)'/);
  switch (match?.[1]) {
    case "AC Power":
      return false;
    // A UPS reports itself while the mains supply is out.
    case "Battery Power":
    case "UPS Power":
      return true;
    default:
      throw new Error(`Unrecognized pmset -g batt output: ${JSON.stringify(output.trim())}`);
  }
}

/**
 * Parse the energy mode from `pmset -g`. Most Macs report `lowpowermode` (1 is
 * Low Power Mode); those that also offer High Power Mode report `powermode`
 * instead (0 automatic, 1 low power, 2 high power).
 */
export function parseLowPowerMode(output: string): boolean {
  const match = output.match(/^\s*(lowpowermode|powermode)\s+(\d)\s*$/m);
  if (!match) throw new Error("pmset -g reports neither lowpowermode nor powermode");
  return match[2] === "1";
}

const PMSET_TIMEOUT_MS = 3_000;

async function pmset(args: string[]): Promise<string> {
  const proc = Bun.spawn(["/usr/bin/pmset", ...args], { stdout: "pipe", stderr: "pipe", timeout: PMSET_TIMEOUT_MS });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (proc.signalCode) throw new Error(`pmset ${args.join(" ")} did not finish within ${PMSET_TIMEOUT_MS} ms`);
  if (exitCode !== 0) throw new Error(`pmset ${args.join(" ")} exited with code ${exitCode}: ${stderr.trim()}`);
  return stdout;
}

export async function detectPowerStatus(): Promise<PowerStatus> {
  if (process.platform !== "darwin") {
    throw new Error("require_ac_power is only supported on macOS");
  }
  const [batt, settings] = await Promise.all([pmset(["-g", "batt"]), pmset(["-g"])]);
  return { onBattery: parsePowerSource(batt), lowPowerMode: parseLowPowerMode(settings) };
}
