import { describe, expect, it } from "bun:test";
import { parsePort, workspacePort } from "./ports";

describe("parsePort", () => {
  it("accepts a valid port", () => {
    expect(parsePort("27530", "TEST_PORT")).toBe(27530);
  });

  it.each(["", " ", "0", "-1", "1.5", "65536", "invalid"])(
    "rejects invalid port %p",
    (value) => {
      expect(() => parsePort(value, "TEST_PORT")).toThrow(
        `TEST_PORT must be a valid TCP port, got '${value}'`,
      );
    },
  );
});

describe("workspacePort", () => {
  it("returns undefined outside styal and T3 Code", () => {
    expect(workspacePort("web", {})).toBeUndefined();
  });

  it("assigns distinct ports to each development service", () => {
    const env = { STYAL_WORKSPACE_PORT: "27530" };
    expect(workspacePort("web", env)).toBe(27530);
    expect(workspacePort("api", env)).toBe(27531);
    expect(workspacePort("playwright", env)).toBe(27532);
  });

  it("prefers STYAL_WORKSPACE_PORT over T3CODE_WORKSPACE_PORT", () => {
    const env = { STYAL_WORKSPACE_PORT: "27530", T3CODE_WORKSPACE_PORT: "31000" };
    expect(workspacePort("web", env)).toBe(27530);
  });

  it("uses T3CODE_WORKSPACE_PORT in T3 Code", () => {
    expect(workspacePort("api", { T3CODE_WORKSPACE_PORT: "31000" })).toBe(31001);
  });

  it("validates the base port before applying an offset", () => {
    expect(() => workspacePort("playwright", { STYAL_WORKSPACE_PORT: "-1" })).toThrow(
      "STYAL_WORKSPACE_PORT must be a valid TCP port, got '-1'",
    );
  });

  it("rejects an offset that exceeds the TCP port range", () => {
    expect(() => workspacePort("api", { T3CODE_WORKSPACE_PORT: "65535" })).toThrow(
      "T3CODE_WORKSPACE_PORT + 1 must be a valid TCP port, got '65536'",
    );
  });
});
