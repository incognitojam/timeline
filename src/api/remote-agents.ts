import { Hono } from "hono";
import { getAppStateDb } from "../db/app-state";
import { getSyncSourceRow, parseSyncSourceSettings } from "../sync/config";
import {
  authorizedKeysLine,
  generateKey,
  HostKeyMismatchError,
  hostLabel,
  KeyExistsError,
  isHostTrusted,
  probe,
  readPublicKey,
  remoteAgentsPaths,
  type RemoteAgentsPaths,
  scanHostKey,
  trustHost,
} from "../sync/remote-agents";
import { parseRemoteAgentsConfig, REMOTE_AGENTS_SOURCE, type RemoteAgentsConfig } from "../sync/sources/remote-agents";
import { isRecord } from "../shared/guards";

const BASE = `/api/sync/sources/${REMOTE_AGENTS_SOURCE}/ssh`;

function savedConfig(): RemoteAgentsConfig {
  const row = getSyncSourceRow(REMOTE_AGENTS_SOURCE, getAppStateDb());
  return parseRemoteAgentsConfig(row ? parseSyncSourceSettings(row) : undefined);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Outcome of Test connection: the host key to confirm before first use, the
 * targets a trusted host serves, or why the connection failed.
 */
async function testConnection(paths: RemoteAgentsPaths, config: RemoteAgentsConfig) {
  const host = hostLabel(config.host);
  const untrusted = async (changed: boolean) => {
    const scanned = await scanHostKey(config.host);
    return { status: "untrusted" as const, host, fingerprint: scanned.fingerprint, changed };
  };
  if (!isHostTrusted(paths, config.host)) return untrusted(false);
  try {
    const probed = await probe(paths, config.host);
    if (probed.kind === "unreachable") return { status: "error" as const, host, error: probed.message };
    return { status: "ok" as const, host, targets: probed.targets };
  } catch (error) {
    if (error instanceof HostKeyMismatchError) return untrusted(true);
    throw error;
  }
}

export function createRemoteAgentsRoutes(paths: () => RemoteAgentsPaths = () => remoteAgentsPaths()) {
  return new Hono()
    .get(BASE, (c) => {
      const publicKey = readPublicKey(paths());
      let host: { label: string; trusted: boolean } | null = null;
      try {
        const config = savedConfig();
        host = { label: hostLabel(config.host), trusted: isHostTrusted(paths(), config.host) };
      } catch {
        // No usable host settings yet; the settings form reports what is missing.
      }
      return c.json({
        publicKey,
        authorizedKeysLine: publicKey ? authorizedKeysLine(publicKey) : null,
        host,
      });
    })

    .post(`${BASE}/key`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const replace = isRecord(body) && body.replace === true;
      try {
        const publicKey = await generateKey(paths(), { replace });
        return c.json({ publicKey, authorizedKeysLine: authorizedKeysLine(publicKey) });
      } catch (error) {
        if (error instanceof KeyExistsError) {
          return c.json({ error: "An SSH key already exists; send {\"replace\": true} to rotate it" }, 409);
        }
        return c.json({ error: message(error) }, 500);
      }
    })

    .post(`${BASE}/test`, async (c) => {
      if (!readPublicKey(paths())) return c.json({ error: "Generate an SSH key first" }, 400);
      let config: RemoteAgentsConfig;
      try {
        config = savedConfig();
      } catch (error) {
        return c.json({ error: message(error) }, 400);
      }
      try {
        return c.json(await testConnection(paths(), config));
      } catch (error) {
        return c.json({ status: "error", host: hostLabel(config.host), error: message(error) });
      }
    })

    .post(`${BASE}/trust`, async (c) => {
      const body = await c.req.json().catch(() => null);
      if (!isRecord(body) || typeof body.fingerprint !== "string" || !body.fingerprint.startsWith("SHA256:")) {
        return c.json({ error: "Expected {\"fingerprint\": \"SHA256:...\"}", field: "fingerprint" }, 400);
      }
      if (!readPublicKey(paths())) return c.json({ error: "Generate an SSH key first" }, 400);
      let config: RemoteAgentsConfig;
      try {
        config = savedConfig();
      } catch (error) {
        return c.json({ error: message(error) }, 400);
      }
      try {
        await trustHost(paths(), config.host, body.fingerprint);
        return c.json(await testConnection(paths(), config));
      } catch (error) {
        return c.json({ status: "error", host: hostLabel(config.host), error: message(error) });
      }
    });
}
