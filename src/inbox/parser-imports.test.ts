import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(SRC, "..");

/** Modules that load parsers on demand while the service worker processes a file. */
const DISPATCHERS = ["inbox/process.ts", "inbox/zip-handlers.ts", "platforms/google/takeout/handler.ts"];

function dispatchedParsers(): string[] {
  const parsers = new Set<string>();
  for (const dispatcher of DISPATCHERS) {
    const path = join(SRC, dispatcher);
    for (const [, specifier] of readFileSync(path, "utf8").matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) {
      if (!specifier?.startsWith(".")) continue;
      const resolved = resolve(dirname(path), `${specifier}.ts`);
      if (!resolved.endsWith("zip-handlers.ts") && !resolved.endsWith("takeout/handler.ts")) parsers.add(resolved);
    }
  }
  return [...parsers].sort();
}

const PARSERS = dispatchedParsers();
const name = (path: string) => relative(SRC, path);

/** A main module that imports each parser in turn, so none of them is the main module. */
async function importParsers(args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "parser-import-"));
  try {
    const script = join(dir, "import-parsers.ts");
    const imports = PARSERS.map((parser) => `await import(${JSON.stringify(parser)});\nconsole.log(${JSON.stringify(`LOADED ${name(parser)}`)});\n`);
    writeFileSync(script, imports.join(""));
    const proc = Bun.spawn([process.execPath, "run", script, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, TIMELINE_DB_PATH: join(dir, "timeline.db") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { exitCode, stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("parsers the inbox dispatch imports", () => {
  test("the list includes every Takeout service", () => {
    expect(PARSERS.map(name)).toEqual(
      expect.arrayContaining(
        ["calendar", "chat", "chrome", "fit", "fitbit", "keep", "location", "search", "youtube"].map((service) => `platforms/google/${service}/parser.ts`),
      ),
    );
  });

  // No arguments is what a worker sees; arguments are what the inbox CLI sees.
  test.each([[[]], [["--only", "google-takeout"]]] as string[][][])("importing them with arguments %j has no side effects", async (args) => {
    const loaded = PARSERS.map((parser) => `LOADED ${name(parser)}\n`).join("");
    expect(await importParsers(args)).toEqual({ exitCode: 0, stdout: loaded });
  });

  test.each(PARSERS.map((parser) => [name(parser), parser] as const))("%s only exits from its CLI block", (_, parser) => {
    const source = readFileSync(parser, "utf8");
    const importable = source.split("if (import.meta.main)")[0];
    expect(importable).not.toContain("process.exit(");
  });
});

describe("Takeout parser CLIs", () => {
  const CLI_PARSERS = ["calendar", "chrome", "fit", "keep", "search", "youtube"].map((service) => `src/platforms/google/${service}/parser.ts`);

  async function runCli(args: string[], dbPath: string) {
    const proc = Bun.spawn([process.execPath, "run", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, TIMELINE_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { exitCode, stdout };
  }

  test.each(CLI_PARSERS)("%s prints usage and fails without arguments", async (parser) => {
    const dir = mkdtempSync(join(tmpdir(), "parser-cli-"));
    try {
      const { exitCode, stdout } = await runCli([parser], join(dir, "timeline.db"));
      expect(exitCode).toBe(1);
      expect(stdout).toContain(`Usage: bun run ${parser}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a parser run with arguments imports its export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parser-cli-"));
    try {
      const exportDir = join(dir, "Fit", "All Data");
      mkdirSync(exportDir, { recursive: true });
      writeFileSync(
        join(exportDir, "derived_com.google.activity.segment_example.json"),
        JSON.stringify({
          "Data Points": [
            {
              fitValue: [{ value: { intVal: 8 } }],
              startTimeNanos: `${Date.parse("2021-03-06T08:00:00Z")}000000`,
              endTimeNanos: `${Date.parse("2021-03-06T08:30:00Z")}000000`,
            },
          ],
        }),
      );
      const { exitCode, stdout } = await runCli(["src/platforms/google/fit/parser.ts", join(dir, "Fit"), "alex"], join(dir, "timeline.db"));
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Total events: 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
