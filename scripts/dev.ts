import net from "node:net";
import { parsePort, t3WorkspacePort } from "./ports";
import { waitForServer } from "./readiness";

type DevOptions = {
  open: boolean;
  apiPort?: number;
  webPort?: number;
  viteArgs: string[];
};

function parseArgs(args: string[]): DevOptions {
  const options: DevOptions = { open: false, viteArgs: [] };

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
    if (reservedPorts.has(explicitPort)) {
      throw new Error(`Port ${explicitPort} is already reserved by another dev server process`);
    }
    return explicitPort;
  }
  return findFreePort(reservedPorts);
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
  console.log(`Usage: bun run dev -- [--open] [--api-port PORT] [--web-port PORT] [vite args...]

Starts the API and Vite web app together.

In T3 Code, the web server uses T3CODE_WORKSPACE_PORT and the API uses the next
port. Otherwise, ports are OS-assigned unless pinned via flag or env var.

Options:
  --open             Open the Vite dev server in a browser when ready.
  --api-port PORT    API port. Overrides TIMELINE_PORT/PORT.
  --web-port PORT    Web port. Overrides TIMELINE_WEB_PORT/VITE_PORT.

Set TIMELINE_API_TARGET or API_HOST to proxy the web app to an external API
(e.g. production) instead of starting the local one.

Unknown arguments are passed through to Vite.`);
}

const options = parseArgs(process.argv.slice(2));
const externalApiTarget = process.env.TIMELINE_API_TARGET ?? process.env.API_HOST;

if (externalApiTarget && options.apiPort !== undefined) {
  throw new Error("--api-port conflicts with TIMELINE_API_TARGET/API_HOST (no local API is started)");
}

const apiPort = externalApiTarget
  ? undefined
  : await pickPort(options.apiPort ?? explicitApiPortFromEnv() ?? t3WorkspacePort("api"));
const webPort = await pickPort(
  options.webPort ?? explicitWebPortFromEnv() ?? t3WorkspacePort("web"),
  new Set(apiPort === undefined ? [] : [apiPort]),
);

console.log(
  apiPort === undefined
    ? `[dev] api: ${externalApiTarget} (external, local API not started)`
    : `[dev] api: http://127.0.0.1:${apiPort}`,
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

const api =
  apiPort === undefined
    ? undefined
    : Bun.spawn(["bun", "run", "src/api/index.ts"], {
        env,
        stdio: ["inherit", "inherit", "inherit"],
      });

const children: Bun.Subprocess[] = api === undefined ? [] : [api];

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function exitWithChildren(): Promise<never> {
  if (!shuttingDown) {
    shutdown("SIGTERM");
  }
  const exitCodes = await Promise.all(children.map((child) => child.exited));
  process.exit(exitCodes.find((code) => code !== 0) ?? 0);
}

if (api !== undefined && apiPort !== undefined) {
  // Vite binds in a few hundred milliseconds; the API has to open the database
  // and run migrations first. Starting Vite in that window means a page loaded
  // from its banner proxies to a refused connection and gets a 502, which the
  // query families that opt out of retries surface as a hard error state. Hold
  // the web server - and so every URL the user can click, including Vite's own
  // --open - until the API answers.
  const ready = await waitForServer({
    url: `http://127.0.0.1:${apiPort}/api/health`,
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
  cwd: "web",
  env,
  stdio: ["inherit", "inherit", "inherit"],
});
children.push(web);
if (shuttingDown) {
  web.kill("SIGTERM");
}

await Promise.race(children.map((child) => child.exited));
await exitWithChildren();
