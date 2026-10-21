import { describe, expect, test } from "bun:test";
import {
  checkNetworkGuard,
  DEFAULT_NETWORK_GUARD_ON_UNKNOWN,
  DEFAULT_REQUIRE_UNMETERED,
  DEFAULT_SKIP_BLOCKED_NETWORKS,
  evaluateNetworkGuard,
  meteredFromStatus,
  NETWORK_GUARD_CONFIG_FIELDS,
  type NetworkGuardConfig,
  parseAirportNetwork,
  parseNetworkGuardConfig,
} from "./network-guard";

const config = (overrides: Partial<NetworkGuardConfig> = {}): NetworkGuardConfig => ({
  blockedSsids: ["iPhone"],
  requireUnmetered: false,
  onUnknown: "proceed",
  ...overrides,
});

describe("evaluateNetworkGuard", () => {
  test("proceeds when no SSIDs are blocked", () => {
    expect(evaluateNetworkGuard(config({ blockedSsids: [] }), { ssid: "iPhone" })).toEqual({
      skip: false,
    });
  });

  test("skips on a blocked SSID (case-insensitive substring)", () => {
    const decision = evaluateNetworkGuard(config(), { ssid: "Alice's iPhone" });
    expect(decision.skip).toBe(true);
    expect(decision).toMatchObject({ reason: expect.stringContaining("Alice's iPhone") });
  });

  test("proceeds on a non-blocked SSID", () => {
    expect(evaluateNetworkGuard(config(), { ssid: "Home WiFi" })).toEqual({ skip: false });
  });

  test("proceeds when not on Wi-Fi (ssid null)", () => {
    expect(evaluateNetworkGuard(config(), { ssid: null })).toEqual({ skip: false });
  });

  test("undetermined SSID follows on_unknown=proceed", () => {
    expect(evaluateNetworkGuard(config({ onUnknown: "proceed" }), { ssid: undefined })).toEqual({
      skip: false,
    });
  });

  test("undetermined SSID follows on_unknown=skip", () => {
    const decision = evaluateNetworkGuard(config({ onUnknown: "skip" }), { ssid: undefined });
    expect(decision).toEqual({ skip: true, reason: expect.any(String) });
  });

  test("skips on constrained network when unmetered is required", () => {
    const decision = evaluateNetworkGuard(config({ blockedSsids: [], requireUnmetered: true }), {
      ssid: null,
      isExpensive: false,
      isConstrained: true,
    });
    expect(decision).toEqual({
      skip: true,
      reason: "Network is metered (constrained)",
    });
  });

  test("skips on expensive network when unmetered is required", () => {
    const decision = evaluateNetworkGuard(config({ blockedSsids: [], requireUnmetered: true }), {
      ssid: null,
      isExpensive: true,
      isConstrained: false,
    });
    expect(decision).toEqual({
      skip: true,
      reason: "Network is metered (expensive)",
    });
  });

  test("proceeds on unmetered network when unmetered is required", () => {
    expect(
      evaluateNetworkGuard(config({ blockedSsids: [], requireUnmetered: true }), {
        ssid: "Home WiFi",
        isExpensive: false,
        isConstrained: false,
      }),
    ).toEqual({ skip: false });
  });

  test("undetermined metered status follows on_unknown=proceed", () => {
    expect(
      evaluateNetworkGuard(
        config({ blockedSsids: [], requireUnmetered: true, onUnknown: "proceed" }),
        { ssid: "Home WiFi" },
      ),
    ).toEqual({ skip: false });
  });

  test("undetermined metered status follows on_unknown=skip", () => {
    const decision = evaluateNetworkGuard(
      config({ blockedSsids: [], requireUnmetered: true, onUnknown: "skip" }),
      { ssid: "Home WiFi" },
    );
    expect(decision).toEqual({
      skip: true,
      reason: "Metered network status could not be determined",
    });
  });

  test("continues to metered check when SSID is unknown but unknown policy proceeds", () => {
    const decision = evaluateNetworkGuard(
      config({ requireUnmetered: true, onUnknown: "proceed" }),
      { ssid: undefined, isExpensive: false, isConstrained: true },
    );
    expect(decision).toEqual({
      skip: true,
      reason: "Network is metered (constrained)",
    });
  });
});

describe("parseNetworkGuardConfig", () => {
  const blockedNetworks = ["iPhone", "Train WiFi"];

  test("exposes the parser defaults through the editable schema", () => {
    expect(NETWORK_GUARD_CONFIG_FIELDS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "skip_blocked_networks", default: DEFAULT_SKIP_BLOCKED_NETWORKS }),
        expect.objectContaining({ key: "require_unmetered", default: DEFAULT_REQUIRE_UNMETERED }),
        expect.objectContaining({ key: "on_unknown", default: DEFAULT_NETWORK_GUARD_ON_UNKNOWN }),
      ])
    );
  });

  test("returns null when unconfigured", () => {
    expect(parseNetworkGuardConfig(undefined, blockedNetworks)).toBeNull();
    expect(parseNetworkGuardConfig({ interval: "6h" }, blockedNetworks)).toBeNull();
  });

  test("returns null for on_unknown without other checks (nothing to evaluate)", () => {
    expect(parseNetworkGuardConfig({ on_unknown: "skip" }, blockedNetworks)).toBeNull();
  });

  test("uses the shared blocked networks when the source opts in", () => {
    expect(parseNetworkGuardConfig({ skip_blocked_networks: true }, blockedNetworks)).toEqual({
      blockedSsids: ["iPhone", "Train WiFi"],
      requireUnmetered: false,
      onUnknown: "proceed",
    });
  });

  test("ignores the shared blocked networks when the source has not opted in", () => {
    expect(parseNetworkGuardConfig({ skip_blocked_networks: false }, blockedNetworks)).toBeNull();
    expect(parseNetworkGuardConfig({ require_unmetered: true }, blockedNetworks)).toEqual({
      blockedSsids: [],
      requireUnmetered: true,
      onUnknown: "proceed",
    });
  });

  test("returns null when the source opts in but no networks are blocked", () => {
    expect(parseNetworkGuardConfig({ skip_blocked_networks: true }, [])).toBeNull();
  });

  test("returns null when require_unmetered is explicitly false without other checks", () => {
    expect(parseNetworkGuardConfig({ require_unmetered: false }, blockedNetworks)).toBeNull();
  });

  test("throws on a malformed skip_blocked_networks value", () => {
    expect(() => parseNetworkGuardConfig({ skip_blocked_networks: "true" }, blockedNetworks)).toThrow();
  });

  test("throws on a malformed require_unmetered value", () => {
    expect(() => parseNetworkGuardConfig({ require_unmetered: "true" }, blockedNetworks)).toThrow();
  });

  test("throws on an invalid on_unknown", () => {
    expect(() =>
      parseNetworkGuardConfig({ skip_blocked_networks: true, on_unknown: "maybe" }, blockedNetworks)
    ).toThrow();
  });
});

describe("meteredFromStatus", () => {
  test("treats expensive or constrained paths as metered", () => {
    expect(meteredFromStatus({ ssid: null, isExpensive: true, isConstrained: false })).toBe(true);
    expect(meteredFromStatus({ ssid: null, isExpensive: false, isConstrained: true })).toBe(true);
  });

  test("treats known non-expensive unconstrained paths as unmetered", () => {
    expect(meteredFromStatus({ ssid: null, isExpensive: false, isConstrained: false })).toBe(false);
  });

  test("returns undefined when either metered signal is unknown", () => {
    expect(meteredFromStatus({ ssid: null, isExpensive: false })).toBeUndefined();
    expect(meteredFromStatus({ ssid: null })).toBeUndefined();
  });
});

describe("parseAirportNetwork", () => {
  test("parses a readable SSID", () => {
    expect(parseAirportNetwork("Current Wi-Fi Network: Home WiFi")).toBe("Home WiFi");
  });

  test("treats not-associated output as unknown unless active path is known not to be Wi-Fi", () => {
    const output = "You are not associated with an AirPort network.";
    expect(parseAirportNetwork(output, { usesWifi: true })).toBeUndefined();
    expect(parseAirportNetwork(output)).toBeUndefined();
    expect(parseAirportNetwork(output, { usesWifi: false })).toBeNull();
  });

  test("treats powered-off Wi-Fi as definitively not on Wi-Fi", () => {
    expect(parseAirportNetwork("Wi-Fi power is currently off.")).toBeNull();
  });
});

describe("checkNetworkGuard", () => {
  test("uses the injected detector and returns the observed status", async () => {
    const result = await checkNetworkGuard(config(), {
      detect: async () => ({ ssid: "iPhone" }),
    });
    expect(result.decision.skip).toBe(true);
    expect(result.status).toEqual({ ssid: "iPhone" });
  });
});
