import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("test preload ignores the developer host config", async () => {
  workDir = mkdtempSync(join(tmpdir(), "timeline-config-test-"));
  const fakeHome = join(workDir, "home");
  const hostConfigDir = join(fakeHome, ".config", "timeline");
  const hostMediaPath = join(workDir, "host-media");
  const hostEnvMediaPath = join(workDir, "host-env-media");

  mkdirSync(hostConfigDir, { recursive: true });
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

  const childEnv = baseChildEnv();

  const proc = Bun.spawn(
    [
      process.execPath,
      "--preload",
      "./test/setup.ts",
      "-e",
      `
import { loadConfig } from "./src/config/index.ts";

const config = await loadConfig();
if (config.media.path === ${JSON.stringify(hostMediaPath)}) {
  throw new Error("loaded host media path");
}
if (config.media.path === ${JSON.stringify(hostEnvMediaPath)}) {
  throw new Error("loaded host env media path");
}
if (config.media.r2) {
  throw new Error("loaded host R2 config");
}
if (!process.env.TIMELINE_CONFIG) {
  throw new Error("test setup did not set TIMELINE_CONFIG");
}
if (!process.env.TIMELINE_ENV_FILE) {
  throw new Error("test setup did not set TIMELINE_ENV_FILE");
}
if (process.env.R2_ACCESS_KEY_ID) {
  throw new Error("loaded host env secrets");
}
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...childEnv,
        HOME: fakeHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  expect(proc.exitCode).toBe(0);
  expect(stderr).toBe("");
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
