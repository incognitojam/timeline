import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { DEFAULT_SERVER_PORT } from "../src/config";
import {
  claimState,
  clearState,
  CorruptStateError,
  type DevState,
  LOG_PATH,
  processIdentity,
  processStartTime,
  REPO_ROOT,
  readLiveState,
  readState,
  writeState,
} from "./dev-state";
import { parsePort, t3WorkspacePort } from "./ports";
import { waitForServer } from "./readiness";

type DevOptions = {
  open: boolean;
  /** Set only by a --background parent: the log its detached child starts in. */
  launchLog?: string;
  background: boolean;
  apiPort?: number;
  webPort?: number;
  viteArgs: string[];
};

function parseArgs(args: string[]): DevOptions {
  const options: DevOptions = { open: false, background: false, viteArgs: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--open":
        options.open = true;
        break;
      case "--background":
        options.background = true;
        break;
      case "--internal-launch-log": {
        const value = args[index + 1];
        if (!value) throw new Error("Missing value for --internal-launch-log");
        index += 1;
        options.launchLog = value;
        break;
      }
      case "--api-port": {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("Missing value for --api-port");
        }
        index += 1;
        options.apiPort = parsePort(value, "--api-port");
        break;
      }
      case "--web-port": {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          throw new Error("Missing value for --web-port");
        }
        index += 1;
        options.webPort = parsePort(value, "--web-port");
        break;
      }
      default:
        options.viteArgs.push(arg);
        break;
    }
  }

  return options;
}

async function findFreePort(reservedPorts = new Set<number>()): Promise<number> {
  while (true) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to get assigned port"));
          return;
        }
        const assignedPort = address.port;
        server.close(() => resolve(assignedPort));
      });
    });
    if (!reservedPorts.has(port)) {
      return port;
    }
  }
}

async function pickPort(
  explicitPort?: number,
  reservedPorts = new Set<number>(),
): Promise<number> {
  if (explicitPort !== undefined) {
    if (explicitPort === DEFAULT_SERVER_PORT) {
      throw new Error(
        `Port ${DEFAULT_SERVER_PORT} is the installed Timeline service's port; pick another for local dev`,
      );
    }
    if (reservedPorts.has(explicitPort)) {
      throw new Error(`Port ${explicitPort} is already reserved by another dev server process`);
    }
    return explicitPort;
  }
  return findFreePort(new Set([...reservedPorts, DEFAULT_SERVER_PORT]));
}

function explicitApiPortFromEnv(): number | undefined {
  const explicit = process.env.TIMELINE_PORT ?? process.env.PORT;
  return explicit ? parsePort(explicit, "TIMELINE_PORT/PORT") : undefined;
}

function explicitWebPortFromEnv(): number | undefined {
  const explicit = process.env.TIMELINE_WEB_PORT ?? process.env.VITE_PORT;
  return explicit ? parsePort(explicit, "TIMELINE_WEB_PORT/VITE_PORT") : undefined;
}

function printHelp() {
  console.log(`Usage: bun run dev -- [--background] [--open]
                    [--api-port PORT] [--web-port PORT] [vite args...]

Starts the API and Vite web app together.

In T3 Code, the web server uses T3CODE_WORKSPACE_PORT and the API uses the next
port. Otherwise, ports are OS-assigned unless pinned via flag or env var.
Port ${DEFAULT_SERVER_PORT} (the installed service) is never used.

Options:
  --background       Start detached, log to .dev/dev.log, and return once ready.
  --open             Open the Vite dev server in a browser when ready.
  --api-port PORT    API port. Overrides TIMELINE_PORT/PORT.
  --web-port PORT    Web port. Overrides TIMELINE_WEB_PORT/VITE_PORT.

Companions: bun run dev:status | dev:stop

Set TIMELINE_API_TARGET or API_HOST to proxy the web app to an external API
(e.g. production) instead of starting the local one.

Unknown arguments are passed through to Vite.`);
}

const options = parseArgs(process.argv.slice(2));
const externalApiTarget = process.env.TIMELINE_API_TARGET ?? process.env.API_HOST;

if (externalApiTarget && options.apiPort !== undefined) {
  throw new Error("--api-port conflicts with TIMELINE_API_TARGET/API_HOST (no local API is started)");
}

function exitAlreadyRunning(running: DevState): never {
  console.error(
    `[dev] already running in this worktree (pid ${running.supervisor.pid}): web ${running.webUrl}` +
      `${running.apiUrl ? `, api ${running.apiUrl}` : ""}\n[dev] stop it first with: bun run dev:stop`,
  );
  process.exit(1);
}

function readLiveStateOrExit(): DevState | null {
  try {
    return readLiveState();
  } catch (error) {
    if (!(error instanceof CorruptStateError)) throw error;
    console.error(`[dev] ${error.message}`);
    process.exit(1);
  }
}

// A fast check before spawning anything; claimState below is the atomic one.
const running = readLiveStateOrExit();
if (running) exitAlreadyRunning(running);

if (options.background) {
  // Re-run this script detached as its own process-group leader, so dev:stop
  // can signal the whole tree, then return once it reports ready.
  mkdirSync(join(REPO_ROOT, ".dev"), { recursive: true });
  // Log to a per-launch file until the child wins the claim, so a launch that
  // loses to a running server cannot truncate that server's log.
  const launchLog = join(REPO_ROOT, ".dev", `launch-${process.pid}.log`);
  const logFd = openSync(launchLog, "w");
  const currentLog = () => (existsSync(launchLog) ? launchLog : LOG_PATH);
  const args = process.argv.slice(2).filter((arg) => arg !== "--background");
  const child = Bun.spawn([process.execPath, import.meta.path, ...args, "--internal-launch-log", launchLog], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const deadline = Date.now() + 10 * 60_000;
  while (true) {
    let state: DevState | null = null;
    try {
      state = readState();
    } catch {
      // Mid-write or foreign; the child owns the file, so keep waiting.
    }
    if (state?.supervisor.pid === child.pid && state.status === "ready") {
      console.log(`[dev] running in background (pid ${child.pid})`);
      console.log(`[dev] web: ${state.webUrl}`);
      console.log(`[dev] api: ${state.apiUrl ?? state.externalApi}`);
      console.log(`[dev] log: ${LOG_PATH}`);
      console.log("[dev] status: bun run dev:status   stop: bun run dev:stop");
      process.exit(0);
    }
    if (exited) {
      const log = currentLog();
      console.error(`[dev] background server exited during startup; log follows (${log}):\n`);
      console.error(readFileSync(log, "utf8"));
      rmSync(launchLog, { force: true });
      process.exit(1);
    }
    if (Date.now() > deadline) {
      console.error(
        `[dev] still starting after 10 minutes and left running (pid ${child.pid}); ` +
          `see ${currentLog()}, or stop it with: bun run dev:stop`,
      );
      process.exit(1);
    }
    await Bun.sleep(200);
  }
}

const { launchLog } = options;
const background = launchLog !== undefined;

const apiPort = externalApiTarget
  ? undefined
  : await pickPort(options.apiPort ?? explicitApiPortFromEnv() ?? t3WorkspacePort("api"));
const webPort = await pickPort(
  options.webPort ?? explicitWebPortFromEnv() ?? t3WorkspacePort("web"),
  new Set(apiPort === undefined ? [] : [apiPort]),
);

const apiUrl = apiPort === undefined ? null : `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;

console.log(
  apiUrl === null
    ? `[dev] api: ${externalApiTarget} (external, local API not started)`
    : `[dev] api: ${apiUrl}`,
);
console.log(`[dev] web: starting on port ${webPort}`);

// Local dev runs unauthenticated. The host env file (~/.config/timeline/env)
// supplies AUTH_PASSWORD for the launchd service; loading it here would put a
// login page in front of the dev API. Setting it empty makes loadEnvFile skip
// the key while still loading the other secrets (Discord, Trakt, ...).
// Set AUTH_PASSWORD in your shell to exercise the login flow.
const devAuthPassword = process.env.AUTH_PASSWORD ?? "";

const env = {
  ...process.env,
  NODE_ENV: "development",
  AUTH_PASSWORD: devAuthPassword,
  ...(apiPort === undefined ? {} : { TIMELINE_PORT: String(apiPort) }),
  TIMELINE_WEB_PORT: String(webPort),
};

if (devAuthPassword) {
  console.log("[dev] auth: enabled (AUTH_PASSWORD set in shell)");
}

const supervisor = processIdentity(process.pid);
const state: DevState = {
  supervisor,
  children: [],
  status: "starting",
  background,
  webUrl,
  apiUrl,
  externalApi: externalApiTarget ?? null,
  logFile: background ? LOG_PATH : null,
};
// Claim the worktree before spawning anything, so a concurrent start cannot
// launch a second, untracked server.
const claimedBy = claimState(state);
if (claimedBy) exitAlreadyRunning(claimedBy);
// Our open log descriptor follows the rename.
if (launchLog !== undefined) renameSync(launchLog, LOG_PATH);

const api =
  apiPort === undefined
    ? undefined
    : Bun.spawn(["bun", "run", "src/api/index.ts"], {
        cwd: REPO_ROOT,
        env,
        stdio: ["inherit", "inherit", "inherit"],
      });

const children: Array<{ name: string; process: Bun.Subprocess }> =
  api === undefined ? [] : [{ name: "api", process: api }];

const recordState = () => {
  // A child that already exited has no start time; the exit handler below
  // shuts the rest down.
  state.children = children.flatMap((child) => {
    const startedAt = processStartTime(child.process.pid);
    return startedAt ? [{ name: child.name, pid: child.process.pid, startedAt }] : [];
  });
  writeState(state);
};
recordState();

let shuttingDown = false;
let stopRequested = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.process.kill(signal);
  }
};
const requestStop = (signal: NodeJS.Signals) => {
  stopRequested = true;
  shutdown(signal);
};

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGHUP", () => requestStop("SIGTERM"));

async function exitWithChildren(): Promise<never> {
  if (!shuttingDown) {
    shutdown("SIGTERM");
  }
  const exitCodes = await Promise.all(children.map((child) => child.process.exited));
  clearState(supervisor);
  console.log("[dev] stopped");
  // Children killed on request exit non-zero; only an unrequested exit fails.
  process.exit(stopRequested ? 0 : (exitCodes.find((code) => code !== 0) ?? 0));
}

if (api !== undefined && apiUrl !== null) {
  // Vite binds in a few hundred milliseconds; the API has to open the database
  // and run migrations first. Starting Vite in that window means a page loaded
  // from its banner proxies to a refused connection and gets a 502, which the
  // query families that opt out of retries surface as a hard error state. Hold
  // the web server - and so every URL the user can click, including Vite's own
  // --open - until the API answers.
  const ready = await waitForServer({
    url: `${apiUrl}/api/health`,
    stopWhen: api.exited,
    onSlow: () => console.log("[dev] api: still starting (migrations may be running)..."),
  });
  if (!ready) {
    // The API exited before it was ready, or Ctrl-C arrived while we waited.
    await exitWithChildren();
  }
  console.log("[dev] api: ready");
} else if (externalApiTarget) {
  // Nothing to wait for: dev did not start this API, so a slow or unreachable
  // external target is not a startup race and blocking on it would strand
  // frontend-only work whenever that host is down. Probe once and warn.
  void waitForServer({
    url: `${externalApiTarget.replace(/\/$/, "")}/api/health`,
    attempts: 1,
  }).then((reachable) => {
    if (!reachable) {
      console.log(
        `[dev] api: ${externalApiTarget} did not answer /api/health - proxied requests will fail`,
      );
    }
  });
}

const webArgs = [
  "bun",
  "run",
  "dev",
  "--",
  "--host",
  "127.0.0.1",
  "--port",
  String(webPort),
  "--strictPort",
  ...options.viteArgs,
  ...(options.open ? ["--open"] : []),
];

const web = Bun.spawn(webArgs, {
  cwd: join(REPO_ROOT, "web"),
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
children.push({ name: "web", process: web });
if (shuttingDown) {
  web.kill("SIGTERM");
} else {
  recordState();
}

void waitForServer({ url: webUrl, stopWhen: web.exited }).then((ready) => {
  if (!ready || shuttingDown) return;
  state.status = "ready";
  writeState(state);
  console.log(`[dev] ready: ${webUrl} (bun run dev:status / dev:stop)`);
});

await Promise.race(children.map((child) => child.process.exited));
await exitWithChildren();
