import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workDir: string | null = null;

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  }
});

async function runConfigChild(script: string, env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  expect(stderr).toBe("");
  expect(proc.exitCode).toBe(0);
  return stdout;
}

function baseChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  delete env.PORT;
  delete env.TIMELINE_CONFIG;
  delete env.TIMELINE_DB_PATH;
  delete env.TIMELINE_ENV_FILE;
  delete env.TIMELINE_ENV_FILE_LOADED;
  delete env.TIMELINE_HOST;
  delete env.TIMELINE_INBOX_PATH;
  delete env.TIMELINE_MEDIA_PATH;
  delete env.TIMELINE_PORT;
  delete env.TIMELINE_PUBLIC_URL;

  return env;
}

test("test preload isolates every host path and removes its run directory", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  const fakeHome = join(workDir, "home");
  const childTmp = join(workDir, "tmp");
  const hostConfigDir = join(fakeHome, ".config", "timeline");
  const hostMediaPath = join(workDir, "host-media");
  const hostEnvMediaPath = join(workDir, "host-env-media");
  const probePath = join(workDir, "probe.test.ts");

  mkdirSync(hostConfigDir, { recursive: true });
  mkdirSync(childTmp);
  writeFileSync(
    join(hostConfigDir, "config.toml"),
    `[media]
path = "${hostMediaPath}"

[media.r2]
enabled = true
account_id = "host-account"
bucket = "host-bucket"
`,
  );
  writeFileSync(
    join(hostConfigDir, "env"),
    `TIMELINE_MEDIA_PATH=${hostEnvMediaPath}
R2_ACCESS_KEY_ID=host-access-key
`,
  );
  writeFileSync(
    probePath,
    `
import { test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { loadConfig } from ${JSON.stringify(join(process.cwd(), "src/config/index.ts"))};
import { getEmbeddingsDbPath } from ${JSON.stringify(join(process.cwd(), "src/embeddings/db.ts"))};
import { getRcloneConfigPath } from ${JSON.stringify(join(process.cwd(), "src/inbox/account-detection.ts"))};

test("probe", async () => {
  const config = await loadConfig();
  // Spawned with Bun's default environment, which the preload must still isolate.
  const child = Bun.spawnSync(["sh", "-c", 'printf "%s\\n%s" "$HOME" "$TMPDIR"']).stdout.toString().split("\\n");
  console.log("PROBE" + JSON.stringify({
    paths: [config.media.path, config.inbox.base_path, config.database.path, getEmbeddingsDbPath(),
      getRcloneConfigPath(), homedir(), tmpdir(),
      require("os").homedir(), process.env.HOME, process.env.TIMELINE_CONFIG, process.env.TIMELINE_ENV_FILE,
      ...child],
    discordDb: process.env.DISCORD_DB_PATH ?? null,
    r2: Boolean(config.media.r2),
    secrets: Boolean(process.env.R2_ACCESS_KEY_ID),
  }));
});
`,
  );

  // bun test, not bun --preload, so bunfig's preload and its lifecycle hooks run
  // exactly as they do for the suite.
  const proc = Bun.spawn([process.execPath, "test", probePath], {
    cwd: process.cwd(),
    env: {
      ...baseChildEnv(),
      HOME: fakeHome,
      TMPDIR: childTmp,
      TIMELINE_EMBEDDINGS_DB_PATH: join(workDir, "host-embeddings.db"),
      RCLONE_CONFIG: join(workDir, "host-rclone.conf"),
      DISCORD_DB_PATH: join(workDir, "host-discord.db"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });

  const line = stdout.split("\n").find((l) => l.startsWith("PROBE"));
  if (!line) throw new Error(`probe printed no result:\n${stdout}\n${stderr}`);
  const probe = JSON.parse(line.slice("PROBE".length)) as {
    paths: string[];
    discordDb: string | null;
    r2: boolean;
    secrets: boolean;
  };
  expect(probe).toMatchObject({ discordDb: null, r2: false, secrets: false });
  const runRoot = probe.paths[0].slice(0, probe.paths[0].indexOf("/", childTmp.length + 1));
  expect(runRoot.startsWith(join(childTmp, "timeline-test-run-"))).toBe(true);
  for (const path of probe.paths) expect(path.startsWith(`${runRoot}/`)).toBe(true);
  expect(readdirSync(childTmp)).toEqual([]);
});

test("test preload removes only its own and dead runs' directories from TMPDIR", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  // Mirrors an agent pointing TMPDIR at the checkout's .scratch/.
  const scratch = join(workDir, ".scratch");
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  const deadRun = `timeline-test-run-${exited.pid}-dead`;
  const kept = [
    `timeline-test-run-${process.pid}-live`,
    "timeline-test-run-",
    "timeline-test-run-not-a-pid",
    "timeline-test-runner",
    // Same length as the run prefix, so a looser match would parse a dead pid.
    `timeline-test-old-${exited.pid}-x`,
    "timeline-test-1",
    "notes.md",
    "other-task",
  ];
  for (const name of [deadRun, ...kept]) mkdirSync(join(scratch, name), { recursive: true });
  const probePath = join(workDir, "probe.test.ts");
  writeFileSync(probePath, `import { test } from "bun:test";\ntest("probe", () => {});\n`);

  const proc = Bun.spawn([process.execPath, "test", probePath], {
    cwd: process.cwd(),
    env: { ...baseChildEnv(), TMPDIR: scratch },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
  expect(readdirSync(scratch).sort()).toEqual(kept.sort());
});

test("test preload keeps .env variables in the working directory out of tests", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  // Bun loads .env and, under bun test, .env.test from the working directory.
  writeFileSync(join(workDir, ".env"), "TIMELINE_DOTENV_PROBE_A=synthetic\n");
  writeFileSync(join(workDir, ".env.test"), 'export TIMELINE_DOTENV_PROBE_B="synthetic"\n');
  writeFileSync(
    join(workDir, "bunfig.toml"),
    `[test]\npreload = [${JSON.stringify(join(process.cwd(), "test/setup.ts"))}]\n`,
  );
  const probePath = join(workDir, "probe.test.ts");
  // Reports variable names only, for this process and for children started with
  // the default environment and with a minimal one.
  writeFileSync(
    probePath,
    `
import { test } from "bun:test";
const leaked = (env: Record<string, string | undefined>) =>
  Object.keys(env).filter((name) => name.startsWith("TIMELINE_DOTENV_PROBE") && env[name]);
const child = (env?: Record<string, string>) =>
  JSON.parse(Bun.spawnSync({
    cmd: [process.execPath, "-e", 'console.log(JSON.stringify(Object.keys(process.env).filter((name) => name.startsWith("TIMELINE_DOTENV_PROBE") && process.env[name])))'],
    ...(env && { env }),
  }).stdout.toString());

test("probe", () => {
  console.log("PROBE" + JSON.stringify({
    self: leaked(process.env),
    defaultEnvChild: child(),
    minimalEnvChild: child({ PATH: process.env.PATH ?? "" }),
  }));
});
`,
  );

  // Through sh, because the preload adds --no-env-file to commands that start
  // with process.execPath, and this run must load .env files as a developer's does.
  const proc = Bun.spawn(["sh", "-c", 'exec "$0" test "$1"', process.execPath, probePath], {
    cwd: workDir,
    env: baseChildEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE"));
  if (!line) throw new Error(`probe printed no result:\n${stdout}\n${stderr}`);
  expect(JSON.parse(line.slice("PROBE".length))).toEqual({ self: [], defaultEnvChild: [], minimalEnvChild: [] });
});

test("loadConfig auto-loads TIMELINE_ENV_FILE before config resolution", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  const configPath = join(workDir, "config.toml");
  const envPath = join(workDir, "env");
  const mediaPath = join(workDir, "media-from-env");
  const databasePath = join(workDir, "timeline-from-env.db");

  writeFileSync(
    configPath,
    `[server]
host = "0.0.0.0"

[media]
path = "${join(workDir, "media-from-config")}"
`,
  );
  writeFileSync(
    envPath,
    `# Env file is loaded before config path resolution.
TIMELINE_CONFIG=${configPath}
TIMELINE_MEDIA_PATH=${mediaPath}
TIMELINE_DB_PATH=${databasePath}
TIMELINE_PORT=4321
QUOTED_SECRET="quoted value # preserved"
export EXPORTED_SECRET='single quoted'
`,
  );

  const stdout = await runConfigChild(
    `
import { loadConfig, getConfigPath } from "./src/config/index.ts";

const config = await loadConfig();
if (getConfigPath() !== ${JSON.stringify(configPath)}) {
  throw new Error("TIMELINE_CONFIG from env file was not applied");
}
if (config.server.host !== "0.0.0.0") {
  throw new Error("TOML config from env-file path was not loaded");
}
if (config.server.port !== 4321) {
  throw new Error("TIMELINE_PORT from env file was not applied");
}
if (config.media.path !== ${JSON.stringify(mediaPath)}) {
  throw new Error("TIMELINE_MEDIA_PATH from env file was not applied");
}
if (config.database.path !== ${JSON.stringify(databasePath)}) {
  throw new Error("TIMELINE_DB_PATH from env file was not applied");
}
if (process.env.QUOTED_SECRET !== "quoted value # preserved") {
  throw new Error("double-quoted env value was not parsed");
}
if (process.env.EXPORTED_SECRET !== "single quoted") {
  throw new Error("exported single-quoted env value was not parsed");
}
console.log("ok");
    `,
    {
      ...baseChildEnv(),
      TIMELINE_ENV_FILE: envPath,
    },
  );

  expect(stdout).toBe("ok\n");
});

test("env file does not override variables exported by the caller", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  const envPath = join(workDir, "env");

  writeFileSync(
    envPath,
    `TIMELINE_PORT=1111
R2_ACCESS_KEY_ID=file-access-key
`,
  );

  const stdout = await runConfigChild(
    `
import { loadConfig } from "./src/config/index.ts";

const config = await loadConfig();
if (config.server.port !== 2222) {
  throw new Error("exported TIMELINE_PORT was overridden by env file");
}
if (process.env.R2_ACCESS_KEY_ID !== "exported-access-key") {
  throw new Error("exported secret was overridden by env file");
}
console.log("ok");
    `,
    {
      ...baseChildEnv(),
      TIMELINE_ENV_FILE: envPath,
      TIMELINE_PORT: "2222",
      R2_ACCESS_KEY_ID: "exported-access-key",
    },
  );

  expect(stdout).toBe("ok\n");
});

test("explicit TIMELINE_CONFIG must exist", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  const missingPath = join(workDir, "missing.toml");
  const proc = Bun.spawn(
    [process.execPath, "-e", 'import { loadConfig } from "./src/config/index.ts"; await loadConfig();'],
    {
      cwd: process.cwd(),
      env: {
        ...baseChildEnv(),
        TIMELINE_CONFIG: missingPath,
        TIMELINE_ENV_FILE: join(workDir, "missing.env"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(proc.exitCode).not.toBe(0);
  expect(stderr).toContain(`TIMELINE_CONFIG does not exist: ${missingPath}`);
});

test("explicit TIMELINE_CONFIG must not be empty", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  const proc = Bun.spawn(
    [process.execPath, "-e", 'import { loadConfig } from "./src/config/index.ts"; await loadConfig();'],
    {
      cwd: process.cwd(),
      env: {
        ...baseChildEnv(),
        TIMELINE_CONFIG: "",
        TIMELINE_ENV_FILE: join(workDir, "missing.env"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(proc.exitCode).not.toBe(0);
  expect(stderr).toContain("TIMELINE_CONFIG does not exist");
});

test("invalid explicit TIMELINE_CONFIG does not fall back", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  const configPath = join(workDir, "invalid.toml");
  writeFileSync(configPath, "[database\npath = broken");
  const proc = Bun.spawn(
    [process.execPath, "-e", 'import { loadConfig } from "./src/config/index.ts"; await loadConfig();'],
    {
      cwd: process.cwd(),
      env: {
        ...baseChildEnv(),
        TIMELINE_CONFIG: configPath,
        TIMELINE_ENV_FILE: join(workDir, "missing.env"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  expect(proc.exitCode).not.toBe(0);
  expect(stderr).toContain(`Could not load TOML config from ${configPath}`);
});
