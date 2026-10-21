import { describe, expect, it } from "bun:test";
import { parsePort, t3WorkspacePort } from "./ports";

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

describe("t3WorkspacePort", () => {
  it("returns undefined outside T3 Code", () => {
    expect(t3WorkspacePort("web", {})).toBeUndefined();
  });

  it("assigns distinct ports to each development service", () => {
    const env = { T3CODE_WORKSPACE_PORT: "27530" };
    expect(t3WorkspacePort("web", env)).toBe(27530);
    expect(t3WorkspacePort("api", env)).toBe(27531);
    expect(t3WorkspacePort("playwright", env)).toBe(27532);
  });

  it("validates the base port before applying an offset", () => {
    expect(() => t3WorkspacePort("playwright", { T3CODE_WORKSPACE_PORT: "-1" })).toThrow(
      "T3CODE_WORKSPACE_PORT must be a valid TCP port, got '-1'",
    );
  });

  it("rejects an offset that exceeds the TCP port range", () => {
    expect(() => t3WorkspacePort("api", { T3CODE_WORKSPACE_PORT: "65535" })).toThrow(
      "T3CODE_WORKSPACE_PORT + 1 must be a valid TCP port, got '65536'",
    );
  });
});
