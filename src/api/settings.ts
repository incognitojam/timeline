import { Hono } from "hono";
import { getAppStateDb, getBlockedNetworks, setBlockedNetworks } from "../db/app-state";
import type { NetworkSettings } from "../shared/network-settings";

function parseBlockedNetworks(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const networks: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const network = entry.trim();
    if (network.length === 0) return null;
    if (!networks.some((existing) => existing.toLowerCase() === network.toLowerCase())) {
      networks.push(network);
    }
  }
  return networks;
}

export function createSettingsRoutes() {
  return new Hono()
    .get("/api/settings/network", (c) => {
      const settings: NetworkSettings = { blockedNetworks: getBlockedNetworks(getAppStateDb()) };
      return c.json(settings);
    })

    .put("/api/settings/network", async (c) => {
      const body = await c.req.json().catch(() => null) as { blockedNetworks?: unknown } | null;
      const blockedNetworks = parseBlockedNetworks(body?.blockedNetworks);
      if (!blockedNetworks) {
        return c.json(
          { error: "blockedNetworks must be an array of non-empty strings", field: "blockedNetworks" },
          400
        );
      }
      setBlockedNetworks(getAppStateDb(), blockedNetworks);
      const settings: NetworkSettings = { blockedNetworks };
      return c.json(settings);
    });
}
