import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const app = process.argv[2];
if (!app || process.argv.length !== 3) throw new Error("usage: bun render-agents.ts <app>");
const directory = join(app, "Contents/Library/LaunchAgents");
mkdirSync(directory, { recursive: true });
// The service runs at normal priority because it serves the API; its sync worker
// lowers its own thread to background priority.
const keepAlive = "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>";
const agentKeys: Record<string, string> = {
  service: keepAlive,
  recall: "<!-- Retained only so the app can unregister the previous Recall agent. -->",
  tailscale: `${keepAlive}<key>ProcessType</key><string>Background</string>`,
};
for (const [name, keys] of Object.entries(agentKeys)) {
  const label = `dev.incognitojam.timeline-${name}`;
  writeFileSync(join(directory, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>AssociatedBundleIdentifiers</key><array><string>com.incognitojam.timeline</string></array>
  <key>BundleProgram</key><string>Contents/MacOS/TimelineAgent</string>
  <key>ProgramArguments</key><array><string>TimelineAgent</string><string>${name}</string></array>
  ${keys}
</dict></plist>
`);
}
