import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SQLITE_PIN } from "../../src/db/sqlite-pin";
import { buildId, verifySource } from "./build";

test("source corruption fails before compilation with a remediation", () => {
  const source = new TextEncoder().encode("synthetic source");
  expect(() => verifySource(source)).toThrow("sha256 mismatch");
  verifySource(source, createHash("sha256").update(source).digest("hex") as typeof SQLITE_PIN.source.sha256);
});

test("cache identity changes with source, defines and target", () => {
  const id = buildId("arm64");
  expect(buildId("arm64")).toBe(id);
  expect(buildId("x64")).not.toBe(id);
  expect(buildId("arm64", { ...SQLITE_PIN, source: { ...SQLITE_PIN.source, sha256: "changed" } } as unknown as typeof SQLITE_PIN)).not.toBe(id);
  expect(buildId("arm64", { ...SQLITE_PIN, defines: { ...SQLITE_PIN.defines, SQLITE_ENABLE_FTS5: 0 } } as unknown as typeof SQLITE_PIN)).not.toBe(id);
});
