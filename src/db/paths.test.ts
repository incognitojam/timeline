import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { getDbPathInfo, assertNoLocalDbMarker, getAppStateDbPath, getEmbeddingsDbPath, getServiceDbPath } from "./paths";

describe("paths helpers", () => {
  test("assertNoLocalDbMarker does not throw when marker missing", () => {
    const tempDir = join(tmpdir(), `paths-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const info = getDbPathInfo(join(tempDir, "timeline.db"));

    // Should not throw
    expect(() => {
      assertNoLocalDbMarker(info, info.resolvedDbPath, "database");
    }).not.toThrow();

    rmSync(tempDir, { recursive: true });
  });

  test("assertNoLocalDbMarker throws when marker exists", () => {
    const tempDir = join(tmpdir(), `paths-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, ".no-local-db"), "");

    const info = getDbPathInfo(join(tempDir, "timeline.db"));

    expect(() => {
      assertNoLocalDbMarker(info, info.resolvedDbPath, "database");
    }).toThrow(/Refusing to use database/);

    rmSync(tempDir, { recursive: true });
  });

  test("getAppStateDbPath returns correct path", () => {
    const tempDir = join(tmpdir(), `paths-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const appStatePath = getAppStateDbPath(join(tempDir, "timeline.db"));
    expect(appStatePath).toBe(join(tempDir, "app-state.db"));

    rmSync(tempDir, { recursive: true });
  });

  test("getAppStateDbPath throws when marker exists", () => {
    const tempDir = join(tmpdir(), `paths-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, ".no-local-db"), "");

    expect(() => {
      getAppStateDbPath(join(tempDir, "timeline.db"));
    }).toThrow(/Refusing to use app state database/);

    rmSync(tempDir, { recursive: true });
  });

  test("getEmbeddingsDbPath returns a separate embeddings database path", () => {
    const tempDir = join(tmpdir(), `paths-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    const embeddingsPath = getEmbeddingsDbPath(join(tempDir, "timeline.db"));
    expect(embeddingsPath).toBe(join(tempDir, "embeddings.db"));

    rmSync(tempDir, { recursive: true });
  });

  test("getEmbeddingsDbPath throws when marker exists", () => {
    const tempDir = join(tmpdir(), `paths-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, ".no-local-db"), "");

    expect(() => {
      getEmbeddingsDbPath(join(tempDir, "timeline.db"));
    }).toThrow(/Refusing to use embeddings database/);

    rmSync(tempDir, { recursive: true });
  });
});

describe("no-local-db marker integration", () => {
  let tempDirWithMarker: string;
  let tempDirWithoutMarker: string;

  beforeAll(() => {
    // Create temp directories for integration tests
    tempDirWithMarker = join(tmpdir(), `paths-test-marker-${Date.now()}`);
    tempDirWithoutMarker = join(tmpdir(), `paths-test-no-marker-${Date.now()}`);

    mkdirSync(tempDirWithMarker, { recursive: true });
    mkdirSync(tempDirWithoutMarker, { recursive: true });

    // Create .no-local-db marker in one directory
    writeFileSync(join(tempDirWithMarker, ".no-local-db"), "");
  });

  afterAll(() => {
    // Cleanup
    if (existsSync(tempDirWithMarker)) {
      rmSync(tempDirWithMarker, { recursive: true });
    }
    if (existsSync(tempDirWithoutMarker)) {
      rmSync(tempDirWithoutMarker, { recursive: true });
    }
  });

  test("schema.ts throws when .no-local-db exists", async () => {
    const dbPath = join(tempDirWithMarker, "timeline.db");

    // Run a subprocess that imports schema.ts
    const proc = Bun.spawn([process.execPath, "-e", `import "./src/db/schema.ts"`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TIMELINE_DB_PATH: dbPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(proc.exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to use database");
    expect(stderr).toContain(".no-local-db");
  });

  test("schema.ts succeeds when .no-local-db does not exist", async () => {
    const dbPath = join(tempDirWithoutMarker, "timeline.db");

    // Run a subprocess that imports schema.ts
    const proc = Bun.spawn([process.execPath, "-e", `import "./src/db/schema.ts"`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TIMELINE_DB_PATH: dbPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;

    expect(proc.exitCode).toBe(0);
  });

  test("app-state.ts getAppStateDb throws when .no-local-db exists", async () => {
    const dbPath = join(tempDirWithMarker, "timeline.db");

    // Run a subprocess that calls getAppStateDb
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { getAppStateDb } from "./src/db/app-state.ts"; getAppStateDb();`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TIMELINE_DB_PATH: dbPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(proc.exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to use app state database");
    expect(stderr).toContain(".no-local-db");
  });

  test("app-state.ts getAppStateDb succeeds when .no-local-db does not exist", async () => {
    const dbPath = join(tempDirWithoutMarker, "timeline.db");

    // Run a subprocess that calls getAppStateDb
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { getAppStateDb } from "./src/db/app-state.ts"; getAppStateDb();`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TIMELINE_DB_PATH: dbPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    await proc.exited;

    expect(proc.exitCode).toBe(0);
  });
});

describe("getServiceDbPath", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const keys = ["TIMELINE_ENV_FILE", "TIMELINE_CONFIG", "TIMELINE_DB_PATH"] as const;

  beforeAll(() => {
    for (const key of keys) saved[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const setup = (envFile: string | null) => {
    dir = join(tmpdir(), `service-db-path-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    process.env.TIMELINE_ENV_FILE = join(dir, "env");
    if (envFile !== null) writeFileSync(join(dir, "env"), envFile);
    delete process.env.TIMELINE_CONFIG;
    // A shell's own database path, which the service never sees.
    process.env.TIMELINE_DB_PATH = join(dir, "copy.db");
  };
  const config = (dbPath: string) => {
    const path = join(dir, "config.toml");
    writeFileSync(path, `[database]\npath = "${dbPath}"\n`);
    return path;
  };

  test("takes TIMELINE_DB_PATH from the env file as the service's launcher sources it", () => {
    setup('TIMELINE_DB_PATH="$HOME/elsewhere/timeline.db"\n');
    expect(getServiceDbPath()).toBe(join(homedir(), "elsewhere", "timeline.db"));
  });

  test("reads the config that TIMELINE_CONFIG names, from the env file or this process", () => {
    setup(null);
    const path = config("/data/from-config.db");
    writeFileSync(join(dir, "env"), `TIMELINE_CONFIG=${path}\n`);
    expect(getServiceDbPath()).toBe("/data/from-config.db");
    rmSync(join(dir, "env"));
    process.env.TIMELINE_CONFIG = path;
    expect(getServiceDbPath()).toBe("/data/from-config.db");
  });

  test("refuses a TIMELINE_CONFIG that doesn't exist, or an env file that doesn't source", () => {
    setup(null);
    process.env.TIMELINE_CONFIG = join(dir, "missing.toml");
    expect(() => getServiceDbPath()).toThrow("does not exist");
    setup('TIMELINE_DB_PATH="unterminated\n');
    expect(() => getServiceDbPath()).toThrow("Could not read");
  });
});
