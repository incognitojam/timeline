import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorruptStateError,
  claimState,
  type DevState,
  isAlive,
  parseState,
  processGroup,
  processIdentity,
  processStartTime,
  readLiveState,
  type StopDeps,
  stopTargets,
} from "./dev-state";

function makeState(overrides: Partial<DevState> = {}): DevState {
  return {
    supervisor: { pid: 100, startedAt: "s100" },
    children: [
      { name: "api", pid: 101, startedAt: "s101" },
      { name: "web", pid: 102, startedAt: "s102" },
    ],
    status: "ready",
    background: false,
    webUrl: "http://127.0.0.1:40000",
    apiUrl: "http://127.0.0.1:40001",
    externalApi: null,
    logFile: null,
    ...overrides,
  };
}

function deps(alive: number[], groups: Record<number, number>): StopDeps {
  return {
    isAlive: (identity) => alive.includes(identity.pid),
    processGroup: (pid) => (alive.includes(pid) ? (groups[pid] ?? null) : null),
  };
}

describe("process identity", () => {
  it("recognises a live process by PID and start time", () => {
    expect(isAlive(processIdentity(process.pid))).toBe(true);
  });

  it("reports a stable start time", () => {
    expect(processStartTime(process.pid)).toBe(processStartTime(process.pid));
  });

  it("rejects a reused PID whose start time differs", () => {
    const identity = processIdentity(process.pid);
    expect(isAlive({ ...identity, startedAt: "not-the-start-time" })).toBe(false);
  });

  it("rejects an exited process", async () => {
    const child = Bun.spawn(["true"]);
    const identity = { pid: child.pid, startedAt: "unknown" };
    await child.exited;
    expect(isAlive(identity)).toBe(false);
    expect(processGroup(child.pid)).toBeNull();
  });

  it("sees a detached child lead its own process group", async () => {
    const child = Bun.spawn(["sleep", "5"], { detached: true });
    try {
      expect(processGroup(child.pid)).toBe(child.pid);
      expect(processGroup(process.pid)).not.toBe(child.pid);
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

describe("parseState", () => {
  it("accepts a well-formed state", () => {
    expect(parseState(JSON.stringify(makeState())).supervisor.pid).toBe(100);
  });

  it.each([
    ["invalid JSON", "{"],
    ["no supervisor", JSON.stringify({ ...makeState(), supervisor: undefined })],
    ["a non-positive PID", JSON.stringify(makeState({ supervisor: { pid: 0, startedAt: "x" } }))],
    ["no children (older schema)", JSON.stringify({ ...makeState(), children: undefined })],
    ["a malformed child", JSON.stringify({ ...makeState(), children: [{ name: "web", pid: "1" }] })],
  ])("rejects %s without throwing a raw error", (_, text) => {
    expect(() => parseState(text, "/x/state.json")).toThrow(CorruptStateError);
    expect(() => parseState(text, "/x/state.json")).toThrow("/x/state.json");
  });
});

describe("state file", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dev-state-"));
    path = join(dir, "state.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const live = () => makeState({ supervisor: processIdentity(process.pid), children: [] });

  it("claims an empty slot", () => {
    expect(claimState(live(), path)).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).supervisor.pid).toBe(process.pid);
  });

  it("refuses a second claim while the first server lives", () => {
    claimState(live(), path);
    const second = makeState({ supervisor: { pid: process.pid, startedAt: "other" }, children: [] });
    expect(claimState(second, path)?.supervisor).toEqual(processIdentity(process.pid));
  });

  it("replaces state whose processes are all gone", () => {
    writeFileSync(path, JSON.stringify(makeState({ supervisor: { pid: process.pid, startedAt: "gone" }, children: [] })));
    expect(claimState(live(), path)).toBeNull();
    expect(readLiveState(path)?.supervisor).toEqual(processIdentity(process.pid));
  });

  it("does not replace a corrupt state file", () => {
    writeFileSync(path, "{");
    expect(() => claimState(live(), path)).toThrow(CorruptStateError);
    expect(readFileSync(path, "utf8")).toBe("{");
  });
});

describe("stopTargets", () => {
  it("signals the group when a recorded process is in the supervisor's own group", () => {
    expect(stopTargets(makeState(), deps([100, 101, 102], { 100: 100, 101: 100, 102: 100 }))).toEqual([-100]);
  });

  it("signals only the supervisor when it shares its caller's group", () => {
    expect(stopTargets(makeState(), deps([100, 101, 102], { 100: 7, 101: 7, 102: 7 }))).toEqual([100]);
  });

  it("ignores a background flag that the process groups contradict", () => {
    const state = makeState({ background: true });
    expect(stopTargets(state, deps([100, 101, 102], { 100: 7, 101: 7, 102: 7 }))).toEqual([100]);
  });

  it("signals the surviving group of a killed background supervisor", () => {
    expect(stopTargets(makeState(), deps([101, 102], { 101: 100, 102: 100 }))).toEqual([-100]);
  });

  it("signals orphaned children directly when no group is verified", () => {
    expect(stopTargets(makeState(), deps([102], { 102: 7 }))).toEqual([102]);
  });

  it("signals nothing once every recorded process is gone", () => {
    expect(stopTargets(makeState(), deps([], {}))).toEqual([]);
  });
});
