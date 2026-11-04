import { expect, test } from "bun:test";

test("tests cannot spawn bun from PATH", () => {
  const message = "Tests must spawn process.execPath, not `bun` from PATH";
  expect(() => Bun.spawn(["bun", "--version"])).toThrow(message);
  expect(() => Bun.spawnSync({ cmd: ["bun", "--version"] })).toThrow(message);
  expect(Bun.spawnSync([process.execPath, "--version"]).exitCode).toBe(0);
});
