import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

async function runSuite(
  args: string[],
  options: { fail?: string; requireOverlap?: boolean; ignoreSnapshots?: boolean } = {},
) {
  const scratch = join(repoRoot, ".scratch");
  const ignored = Bun.spawnSync(["git", "check-ignore", "-q", ".scratch"], { cwd: repoRoot });
  if (ignored.exitCode !== 0) throw new Error(".scratch must be ignored before running runner tests");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "test-runner-fixture-"));
  const trace = join(directory, "trace.jsonl");
  const stub = join(directory, "command.ts");
  try {
    mkdirSync(join(directory, "web"));
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "bin"));
    mkdirSync(join(directory, "tools", "timeline-gmessages"), { recursive: true });
    writeFileSync(stub, `
import { appendFileSync, readFileSync } from "node:fs";
const [command, ...args] = process.argv.slice(2);
const inWeb = process.cwd().endsWith("/web");
let step = command;
if (command === "bun") {
  if (args[0] === "install") step = inWeb ? "install-web" : "install-root";
  else if (args[0] === "test") step = args.includes("./scripts/") ? "scripts" : "backend";
  else if (args[1] === "test:run") step = "frontend";
  else if (args[1] === "build") step = "build";
  else step = args[1];
} else if (command === "bunx") {
  step = args[0] === "tsc" ? (inWeb ? "types-web" : "types-root")
    : args[1] === "install" ? "browser-install" : "browser-native";
}
const trace = process.env.RUNNER_TEST_TRACE;
const record = (state) => appendFileSync(trace, JSON.stringify({ step, state, args }) + "\\n");
record("start");
if (step === "backend" && process.env.RUNNER_TEST_REQUIRE_OVERLAP === "1") {
  const deadline = Date.now() + 3000;
  while (!readFileSync(trace, "utf8").includes('"step":"frontend"')) {
    if (Date.now() > deadline) throw new Error("frontend did not start alongside backend");
    await Bun.sleep(2);
  }
}
if (step === process.env.RUNNER_TEST_FAIL) {
  console.error("synthetic failure: " + step);
  process.exit(23);
}
await Bun.sleep(10);
record("end");
`);
    for (const command of ["bun", "bunx", "go"]) {
      writeFileSync(join(directory, "bin", command), [
        "#!/usr/bin/env bash",
        `exec "$RUNNER_TEST_BUN" "$RUNNER_TEST_STUB" ${command} "$@"`,
      ].join("\n"), { mode: 0o755 });
    }
    writeFileSync(join(directory, "bin", "brew"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    writeFileSync(join(directory, "scripts", "test-browser.sh"), [
      "#!/usr/bin/env bash",
      'exec "$RUNNER_TEST_BUN" "$RUNNER_TEST_STUB" browser "$@"',
    ].join("\n"), { mode: 0o755 });
    const child = Bun.spawn(["bash", join(repoRoot, "test.sh"), ...args], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${join(directory, "bin")}:/usr/bin:/bin`,
        RUNNER_TEST_BUN: process.execPath,
        RUNNER_TEST_STUB: stub,
        RUNNER_TEST_TRACE: trace,
        RUNNER_TEST_REQUIRE_OVERLAP: options.requireOverlap ? "1" : "0",
        RUNNER_TEST_FAIL: options.fail ?? "",
        PLAYWRIGHT_IGNORE_SNAPSHOTS: options.ignoreSnapshots ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const records = Bun.file(trace).size === 0 ? [] : readFileSync(trace, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as {
        step: string; state: string; args: string[];
      });
    return { exitCode, output: stdout + stderr, records };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("test suite runner", () => {
  test("overlaps independent unit checks and executes every check", async () => {
    const result = await runSuite(["unit"], { requireOverlap: true });
    expect(result.exitCode).toBe(0);
    expect(result.records.filter((record) => record.state === "end").map((record) => record.step).sort())
      .toEqual(["backend", "frontend", "install-root", "install-web", "scripts", "types-root", "types-web"]);
  });

  test("propagates backend failure even when script tests would succeed", async () => {
    const result = await runSuite(["unit"], { fail: "backend" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("synthetic failure: backend");
    expect(result.records.some((record) => record.step === "scripts")).toBe(false);
    expect(result.records.some((record) => record.step === "frontend" && record.state === "end")).toBe(true);
    expect(result.output).not.toContain("Running backend tests... passed");
  });

  test("backend CI suite runs backend tests, script tests, and type checks", async () => {
    const result = await runSuite(["backend"]);
    expect(result.exitCode).toBe(0);
    expect(result.records.filter((record) => record.state === "end").map((record) => record.step).sort())
      .toEqual(["backend", "install-root", "scripts", "types-root"]);
  });

  test("frontend CI suite runs frontend tests and type checks without repeating the browser build", async () => {
    const result = await runSuite(["frontend"]);
    expect(result.exitCode).toBe(0);
    expect(result.records.filter((record) => record.state === "end").map((record) => record.step).sort())
      .toEqual(["frontend", "install-root", "install-web", "types-web"]);
  });

  test("propagates a frontend failure and waits for the other checks", async () => {
    const result = await runSuite(["unit"], { fail: "frontend" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("synthetic failure: frontend");
    expect(result.records.some((record) => record.step === "scripts" && record.state === "end")).toBe(true);
  });

  test("propagates script failure after backend tests pass", async () => {
    const result = await runSuite(["unit"], { fail: "scripts" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("synthetic failure: scripts");
    expect(result.output).toContain("Running backend tests... failed");
    expect(result.records.some((record) => record.step === "backend" && record.state === "end")).toBe(true);
    expect(result.records.some((record) => record.step === "frontend" && record.state === "end")).toBe(true);
  });

  test("the full suite uses the browser build and propagates browser failure", async () => {
    const result = await runSuite([], { fail: "browser" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("synthetic failure: browser");
    expect(result.records.some((record) => record.step === "build")).toBe(false);
    expect(result.records.some((record) => record.step === "scripts" && record.state === "end")).toBe(true);
  });

  test("forwards browser arguments without installing host dependencies", async () => {
    const result = await runSuite(["browser", "--project=chart-month"]);
    expect(result.exitCode).toBe(0);
    expect(result.records).toEqual([
      { step: "browser", state: "start", args: ["--project=chart-month"] },
      { step: "browser", state: "end", args: ["--project=chart-month"] },
    ]);
  });

  test("installs dependencies and forwards arguments for native browser checks", async () => {
    const result = await runSuite(["browser", "--project=workflows"], { ignoreSnapshots: true });
    expect(result.exitCode).toBe(0);
    expect(result.records.some((record) => record.step === "install-web")).toBe(true);
    expect(result.records.some((record) => record.step === "browser-native"
      && record.args.join(" ") === "playwright test --project=workflows")).toBe(true);
  });

  test("the full suite propagates a browser installation failure", async () => {
    const result = await runSuite([], { ignoreSnapshots: true, fail: "browser-install" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("synthetic failure: browser-install");
    expect(result.records.some((record) => record.step === "browser-native")).toBe(false);
    expect(result.records.some((record) => record.step === "scripts" && record.state === "end")).toBe(true);
  });

  test("rejects extra arguments to non-browser suites before running checks", async () => {
    const result = await runSuite(["unit", "--project=chart-month"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("Usage:");
    expect(result.records).toEqual([]);
  });
});
