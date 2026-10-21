import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDbPathInfo, assertNoLocalDbMarker, getAppStateDbPath, getEmbeddingsDbPath } from "./paths";

describe("paths helpers", () => {
  test("getDbPathInfo returns correct paths", () => {
    const info = getDbPathInfo("/tmp/timeline-test/timeline.db");
    expect(info.resolvedDbPath).toBe("/tmp/timeline-test/timeline.db");
    expect(info.dbParentDir).toBe("/tmp/timeline-test");
    expect(info.noLocalDbMarker).toBe("/tmp/timeline-test/.no-local-db");
  });

  test("getDbPathInfo resolves relative paths", () => {
    const info = getDbPathInfo("./timeline.db");
    expect(info.resolvedDbPath).toContain("timeline.db");
    expect(info.resolvedDbPath).toMatch(/^\//); // Should be absolute
  });

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
    const proc = Bun.spawn(["bun", "-e", `import "./src/db/schema.ts"`], {
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
    const proc = Bun.spawn(["bun", "-e", `import "./src/db/schema.ts"`], {
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
        "bun",
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
        "bun",
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
