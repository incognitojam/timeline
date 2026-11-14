import { resolve } from "node:path";
import { resolveGoogleMessagesConfig } from "../../src/platforms/google-messages/sync";

const artifact = process.argv[2];
if (!artifact) throw new Error("usage: bun check-sidecar.ts <service-artifact>");
process.env.TIMELINE_RESOURCE_ROOT = resolve(artifact, "Resources");
const config = resolveGoogleMessagesConfig({ account: "Bundle smoke test" });
if (typeof config === "string") throw new Error(config);
const expected = resolve(artifact, "bin", "timeline-gmessages");
if (config.binary !== expected) throw new Error(`Sidecar resolved to ${config.binary}, expected ${expected}`);
console.log(`Google Messages default: ${config.binary}`);
console.log(`Google Messages state: ${config.stateDir}`);
