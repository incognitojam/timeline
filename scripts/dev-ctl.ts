/**
 * Companions to `bun run dev`: inspect and stop the dev server recorded in
 * `.dev/state.json`.
 *
 *   bun run dev:status [--json]
 *   bun run dev:stop
 */

import net from "node:net";
import {
  CorruptStateError,
  type DevState,
  isAlive,
  liveProcesses,
  processGroup,
  readLiveState,
  STATE_PATH,
  stopTargets,
} from "./dev-state";

const STOP_TIMEOUT_MS = 45_000;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function describe(state: DevState): string {
  const summary = isAlive(state.supervisor)
    ? `running (${state.status}${state.background ? ", background" : ", foreground"})`
    : "orphaned: the supervisor died but children still run; clean up with bun run dev:stop";
  const lines = [
    summary,
    `  web:  ${state.webUrl}`,
    `  api:  ${state.apiUrl ?? `${state.externalApi} (external)`}`,
    `  pid:  ${state.supervisor.pid} (started ${state.supervisor.startedAt})`,
    ...state.children.map((child) => `        ${child.name}: ${child.pid}${isAlive(child) ? "" : " (exited)"}`),
  ];
  if (state.logFile) lines.push(`  log:  ${state.logFile}`);
  return lines.join("\n");
}

function status(args: string[]): never {
  const state = readLiveState();
  if (args.includes("--json")) {
    console.log(JSON.stringify(state ? { running: true, ...state } : { running: false }, null, 2));
  } else {
    console.log(state ? describe(state) : "not running");
  }
  process.exit(state ? 0 : 1);
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone.
  }
}

/** Whether something accepts connections on a local dev URL's port. */
function portInUse(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function stop(): Promise<never> {
  const state = readLiveState();
  if (!state) {
    console.log("not running");
    process.exit(0);
  }

  const deps = { isAlive, processGroup };
  const supervisorAlive = isAlive(state.supervisor);
  console.log(`stopping dev server (pid ${state.supervisor.pid}${supervisorAlive ? "" : ", orphaned children"})...`);
  for (const target of stopTargets(state, deps)) signal(target, "SIGTERM");

  const all = liveProcesses(state);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (all.some(isAlive) && Date.now() < deadline) await Bun.sleep(200);

  const survivors = all.filter(isAlive);
  if (survivors.length > 0) {
    console.error(`still running after ${STOP_TIMEOUT_MS / 1000}s; sending SIGKILL to ${survivors.map((p) => p.pid).join(", ")}`);
    // Recomputed: the group target is only used while a recorded process verifiably remains in it.
    const targets = new Set([...stopTargets(state, deps), ...survivors.map((survivor) => survivor.pid)]);
    for (const target of targets) signal(target, "SIGKILL");
    await Bun.sleep(500);
  }

  const remaining = all.filter(isAlive);
  if (remaining.length > 0) fail(`could not stop: ${remaining.map((p) => p.pid).join(", ")}`);
  // The supervisor removes the state file itself on a clean exit; this clears
  // it after a SIGKILL.
  readLiveState();

  // Grandchildren such as Vite are not recorded; report one that outlived its parent.
  const urls = [state.webUrl, state.apiUrl].filter((url): url is string => url !== null);
  const busy: string[] = [];
  for (const url of urls) if (await portInUse(url)) busy.push(url);
  if (busy.length > 0) {
    fail(`stopped the recorded processes, but ${busy.join(" and ")} still answers; find it with: lsof -i :<port>`);
  }
  console.log("stopped");
  process.exit(0);
}

const [command, ...args] = process.argv.slice(2).filter((arg) => arg !== "--");
try {
  switch (command) {
    case "status":
      status(args);
      break;
    case "stop":
      await stop();
      break;
    default:
      fail(`Usage: bun run scripts/dev-ctl.ts status|stop (state: ${STATE_PATH})`);
  }
} catch (error) {
  // Nothing is signalled from a state file that cannot be trusted.
  if (error instanceof CorruptStateError) fail(error.message);
  throw error;
}
