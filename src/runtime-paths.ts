import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const RESOURCE_ROOT_ENV = "TIMELINE_RESOURCE_ROOT";

export function getPackagedResourceRoot(): string | null {
  const root = process.env[RESOURCE_ROOT_ENV];
  if (root === undefined) return null;
  if (root === "") {
    throw new Error(`${RESOURCE_ROOT_ENV} must not be empty`);
  }
  if (!isAbsolute(root)) {
    throw new Error(`${RESOURCE_ROOT_ENV} must be an absolute path: ${root}`);
  }
  if (!existsSync(root)) {
    throw new Error(`${RESOURCE_ROOT_ENV} does not exist: ${root}`);
  }
  return root;
}

function requirePackagedPath(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new Error(`Packaged ${label} is missing: ${path}`);
  }
  return path;
}

export function getSchedulerWorkerPath(): string {
  const resourceRoot = getPackagedResourceRoot();
  if (resourceRoot) {
    return requirePackagedPath(
      join(resourceRoot, "runtime", "scheduler", "worker.js"),
      "scheduler worker",
    );
  }
  return fileURLToPath(new URL("./scheduler/worker.ts", import.meta.url));
}

export function getDbPoolWorkerPath(): string | URL {
  const resourceRoot = getPackagedResourceRoot();
  if (resourceRoot) {
    return requirePackagedPath(
      join(resourceRoot, "runtime", "db", "pool-worker.js"),
      "database pool worker",
    );
  }
  return new URL("./db/pool-worker.ts", import.meta.url);
}

export function getMonzoParserPath(): string {
  const resourceRoot = getPackagedResourceRoot();
  if (resourceRoot) {
    return requirePackagedPath(
      join(resourceRoot, "runtime", "parsers", "monzo.js"),
      "Monzo parser",
    );
  }
  return fileURLToPath(new URL("./parsers/monzo.ts", import.meta.url));
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function getMonzoAuthCommand(): string {
  const resourceRoot = getPackagedResourceRoot();
  if (resourceRoot) {
    const launcher = join(dirname(resourceRoot), "bin", "timeline-service");
    return `${quoteShellArgument(launcher)} monzo auth`;
  }
  return "bun run src/parsers/monzo.ts auth";
}

export function findWebDistPath(): string | null {
  const resourceRoot = getPackagedResourceRoot();
  if (resourceRoot) {
    const packagedWeb = join(resourceRoot, "web");
    requirePackagedPath(join(packagedWeb, "index.html"), "web frontend");
    return packagedWeb;
  }

  const candidates = [
    join(process.cwd(), "web", "dist"),
    join(fileURLToPath(new URL("..", import.meta.url)), "web", "dist"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export function getPackagedVersionPath(): string | null {
  const resourceRoot = getPackagedResourceRoot();
  if (!resourceRoot) return null;
  return requirePackagedPath(join(resourceRoot, "version.json"), "version metadata");
}
